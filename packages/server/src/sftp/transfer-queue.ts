/**
 * 传输队列：SFTP 上传/下载任务的调度与执行。
 *
 * 设计要点：
 *
 * 1. **每源一任务**：一次拖拽多个文件会产生多条任务，各自独立暂停/取消/重试，
 *    这与用户的直觉一致（取消其中一个不该影响其它）。
 * 2. **目录是一次任务**：目录递归传输展开成一条任务（进度为聚合值），
 *    而不是几十条子任务 —— 否则传一个 node_modules 会瞬间刷屏。
 * 3. **手写拷贝循环**（而非 `pipe`）：只有逐块掌控才能精确实现
 *    断点续传的字节计数、暂停/恢复与取消；`pipe` 在暂停时已缓冲的数据
 *    仍会写入目标，计数与语义都会失真。
 * 4. **同目标串行**：同一目标路径的任务不允许并行，否则两个任务会互相截断。
 * 5. **失败保留、取消清理**：任务失败时**保留**已写入的部分，
 *    这样「重试」可以断点续传；用户主动取消时删除半成品，
 *    避免留下一个大小不对却顶着正式文件名的文件。
 */
import { EventEmitter, once } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import path from 'node:path'
import {
  SFTP_PROGRESS_INTERVAL_MS,
  SFTP_SPEED_WINDOW,
  SFTP_TRANSFER_RETENTION_MS,
  type CreateTransferRequest,
  type TransferAction,
  type TransferState,
  type TransferTask,
} from '@webterm/shared'
import type { TerminalLogger } from '../terminal/terminal-session.js'
import { SftpError } from './errors.js'
import type { LocalFs } from './local-fs.js'
import { posixBasename, posixJoin, posixParent } from './paths.js'
import type { RemoteFs } from './remote-fs.js'

/** 内部信号：任务被取消（区别于真正的错误） */
class TransferCanceled extends Error {
  constructor() {
    super('传输已取消')
    this.name = 'TransferCanceled'
  }
}

interface TransferPlan {
  /** 远端路径 */
  remotePath: string
  /** 本地绝对路径 */
  localPath: string
  isDirectory: boolean
  size: number
  filesTotal: number
  /** 本次实际开始写入的偏移（断点续传时 > 0） */
  offset: number
  mode: number
}

interface InternalTask {
  task: TransferTask
  options: Required<Pick<CreateTransferRequest, 'overwrite' | 'recursive' | 'preserveMode'>>
  control: {
    paused: boolean
    cancelRequested: boolean
    resumeWaiters: Array<() => void>
  }
  /** 重试时是否尝试续传 */
  resumeRequested: boolean
  /** 速度采样窗口 */
  samples: Array<{ at: number; bytes: number }>
  streams: Array<Readable | Writable>
}

export interface TransferQueueOptions {
  logger: TerminalLogger
  concurrency: number
  local: LocalFs
  remote: RemoteFs
}

export interface TransferQueueEvents {
  update: [task: TransferTask]
  removed: [taskId: string]
}

export class TransferQueue extends EventEmitter<TransferQueueEvents> {
  private readonly tasks = new Map<string, InternalTask>()
  /** 保持入队顺序，保证「先来的先跑」 */
  private readonly order: string[] = []
  private active = 0
  private disposed = false
  private readonly progressTimer: NodeJS.Timeout
  private readonly cleanupTimer: NodeJS.Timeout

  constructor(private readonly opts: TransferQueueOptions) {
    super()
    this.progressTimer = setInterval(() => this.tickProgress(), SFTP_PROGRESS_INTERVAL_MS)
    this.progressTimer.unref?.()
    this.cleanupTimer = setInterval(() => this.pruneFinished(), 60_000)
    this.cleanupTimer.unref?.()
  }

  get concurrency(): number {
    return this.opts.concurrency
  }

  list(): TransferTask[] {
    return this.order
      .map((id) => this.tasks.get(id))
      .filter((t): t is InternalTask => t !== undefined)
      .map((t) => ({ ...t.task }))
  }

  /** 入队；每个源生成一条任务 */
  enqueue(req: CreateTransferRequest): TransferTask[] {
    if (this.disposed) throw new SftpError('INTERNAL', '传输队列已释放')
    const created: TransferTask[] = []

    for (const source of req.sources) {
      const task = this.createTask(req, source)
      this.tasks.set(task.task.id, task)
      this.order.push(task.task.id)
      created.push({ ...task.task })
    }

    this.schedule()
    return created
  }

  private createTask(req: CreateTransferRequest, source: string): InternalTask {
    const isUpload = req.direction === 'upload'
    const name = isUpload ? path.basename(source) : posixBasename(source)
    const target = isUpload ? posixJoin(req.targetDir, name) : path.join(req.targetDir, name)

    const task: TransferTask = {
      id: randomUUID(),
      direction: req.direction,
      source,
      target,
      name,
      state: 'pending',
      size: 0,
      transferred: 0,
      speed: 0,
      etaSec: null,
      filesTotal: 0,
      filesDone: 0,
      isDirectory: false,
      resumable: false,
      createdAt: new Date().toISOString(),
    }

    return {
      task,
      options: {
        overwrite: req.overwrite ?? false,
        recursive: req.recursive ?? true,
        preserveMode: req.preserveMode ?? true,
      },
      control: { paused: false, cancelRequested: false, resumeWaiters: [] },
      resumeRequested: false,
      samples: [],
      streams: [],
    }
  }

  /**
   * 用户操作。非法状态下的操作被静默忽略 —— 前端按钮状态可能与服务端存在
   * 一帧的偏差（进度事件在路上），这时候报错只会打扰用户。
   */
  action(taskId: string, action: TransferAction): TransferTask {
    const entry = this.tasks.get(taskId)
    if (!entry) throw new SftpError('TRANSFER_NOT_FOUND', '传输任务不存在')
    const { task, control } = entry

    switch (action) {
      case 'pause':
        if (task.state === 'running' || task.state === 'pending') {
          control.paused = true
          task.state = 'paused'
          // 排队中的任务被暂停后，调度器会跳过它（state 不再是 pending）
          this.emitUpdate(entry)
        }
        break

      case 'resume':
        if (task.state === 'paused') {
          control.paused = false
          const waiters = control.resumeWaiters
          control.resumeWaiters = []
          for (const resume of waiters) resume()
          if (task.startedAt) {
            task.state = 'running'
            this.emitUpdate(entry)
          } else {
            // 还没开始跑：回到 pending 交给调度器
            task.state = 'pending'
            this.emitUpdate(entry)
            this.schedule()
          }
        }
        break

      case 'cancel':
        if (task.state === 'running' || task.state === 'pending' || task.state === 'paused') {
          control.cancelRequested = true
          control.paused = false
          const waiters = control.resumeWaiters
          control.resumeWaiters = []
          for (const resume of waiters) resume()
          this.destroyStreams(entry)
          task.state = 'canceled'
          task.finishedAt = new Date().toISOString()
          this.emitUpdate(entry)
          void this.cleanupPartial(entry, true)
        }
        break

      case 'retry': {
        if (task.state !== 'failed' && task.state !== 'canceled') break
        // 失败保留的半成品可以续传；主动取消时半成品已被清理，只能从头来
        entry.resumeRequested = task.state === 'failed' && task.resumable
        control.cancelRequested = false
        control.paused = false
        task.state = 'pending'
        task.error = undefined
        task.transferred = entry.resumeRequested ? task.transferred : 0
        task.speed = 0
        task.etaSec = null
        task.startedAt = undefined
        task.finishedAt = undefined
        entry.samples = []
        this.emitUpdate(entry)
        this.schedule()
        break
      }
    }

    return { ...task }
  }

  /** 从队列中移除一条已结束的任务 */
  remove(taskId: string): void {
    const entry = this.tasks.get(taskId)
    if (!entry) throw new SftpError('TRANSFER_NOT_FOUND', '传输任务不存在')
    if (entry.task.state === 'running' || entry.task.state === 'paused' || entry.task.state === 'pending') {
      throw new SftpError('WRONG_TYPE', '任务尚未结束，请先取消')
    }
    this.drop(taskId)
  }

  dispose(): void {
    this.disposed = true
    clearInterval(this.progressTimer)
    clearInterval(this.cleanupTimer)
    for (const entry of this.tasks.values()) {
      entry.control.cancelRequested = true
      this.destroyStreams(entry)
    }
    this.tasks.clear()
    this.order.length = 0
  }

  /* ------------------------------------------------------------------ */
  /* 调度                                                               */
  /* ------------------------------------------------------------------ */

  private schedule(): void {
    if (this.disposed) return
    while (this.active < this.opts.concurrency) {
      const next = this.pickNext()
      if (!next) return
      this.active += 1
      void this.run(next).finally(() => {
        this.active -= 1
        this.schedule()
      })
    }
  }

  private pickNext(): InternalTask | undefined {
    const busyTargets = new Set<string>()
    for (const entry of this.tasks.values()) {
      if (entry.task.state === 'running') busyTargets.add(entry.task.target)
    }

    for (const id of this.order) {
      const entry = this.tasks.get(id)
      if (!entry) continue
      if (entry.task.state !== 'pending') continue
      // 同目标串行：两个任务写同一个路径会互相覆盖
      if (busyTargets.has(entry.task.target)) continue
      return entry
    }
    return undefined
  }

  private async run(entry: InternalTask): Promise<void> {
    const { task } = entry
    task.state = 'running'
    task.startedAt = new Date().toISOString()
    this.emitUpdate(entry)

    try {
      const plan = await this.plan(entry)
      task.isDirectory = plan.isDirectory
      task.size = plan.size
      task.filesTotal = plan.filesTotal
      task.resumable = !plan.isDirectory
      task.transferred = plan.offset
      entry.samples = [{ at: Date.now(), bytes: plan.offset }]
      this.emitUpdate(entry)

      if (plan.isDirectory) {
        await this.runDirectory(entry, plan)
      } else {
        await this.runFile(entry, plan)
      }

      task.transferred = task.size
      this.finish(entry, 'done')
    } catch (err) {
      if (entry.control.cancelRequested || err instanceof TransferCanceled) {
        this.finish(entry, 'canceled')
        void this.cleanupPartial(entry, true)
      } else {
        task.error = err instanceof Error ? err.message : String(err)
        this.finish(entry, 'failed')
        this.opts.logger.warn(
          { taskId: task.id, direction: task.direction, target: task.target, err: task.error },
          '传输任务失败',
        )
      }
    }
  }

  private finish(entry: InternalTask, state: TransferState): void {
    const { task } = entry
    task.state = state
    task.finishedAt = new Date().toISOString()
    task.speed = 0
    task.etaSec = null
    this.destroyStreams(entry)
    this.emitUpdate(entry)

    this.opts.logger.info(
      {
        taskId: task.id,
        direction: task.direction,
        state,
        transferred: task.transferred,
        size: task.size,
      },
      '传输任务结束',
    )
  }

  /* ------------------------------------------------------------------ */
  /* 计划：判定源类型、目标路径、是否需要续传                             */
  /* ------------------------------------------------------------------ */

  private async plan(entry: InternalTask): Promise<TransferPlan> {
    const { task, options } = entry
    const isUpload = task.direction === 'upload'

    if (isUpload) {
      let stats
      try {
        stats = await this.opts.local.stat(task.source)
      } catch (err) {
        throw err instanceof SftpError ? err : new SftpError('NOT_FOUND', `本地源不存在：${task.source}`)
      }
      const isDirectory = stats.type === 'dir'
      if (isDirectory && !options.recursive) {
        throw new SftpError('WRONG_TYPE', '源是目录，需要勾选「递归传输目录」')
      }

      // 目标目录必须存在，否则远端会给出难以理解的失败
      const parent = posixParent(task.target)
      if (parent) await this.opts.remote.mkdirp(parent)

      // 聚合只算一次：目录树可能很大，重复遍历的代价是 O(2n) 次 SFTP 往返
      const aggregate = isDirectory ? await this.opts.local.measure(task.source) : null
      const size = aggregate ? aggregate.size : stats.size

      let offset = 0
      if (entry.resumeRequested && size > 0) {
        const partial = await this.opts.remote.sizeOf(task.target)
        if (partial !== null && partial > 0 && partial < size) offset = partial
      } else if (!isDirectory && !options.overwrite && (await this.opts.remote.exists(task.target))) {
        throw new SftpError('ALREADY_EXISTS', `远端已存在同名文件：${task.target}`, {
          hint: '如需覆盖，请在传输时勾选「覆盖同名文件」。',
        })
      }

      return {
        remotePath: task.target,
        localPath: task.source,
        isDirectory,
        size,
        filesTotal: aggregate ? Math.max(1, aggregate.files) : 1,
        offset,
        mode: options.preserveMode ? stats.mode : 0o644,
      }
    }

    // 下载
    const { entry: remoteEntry } = await this.opts.remote.lstat(task.source)
    const isDirectory = remoteEntry.type === 'dir'
    if (isDirectory && !options.recursive) {
      throw new SftpError('WRONG_TYPE', '源是目录，需要勾选「递归传输目录」')
    }

    await this.opts.local.mkdirp(path.dirname(task.target))

    const aggregate = isDirectory ? await this.measureRemote(task.source) : null
    const size = aggregate ? aggregate.size : remoteEntry.size

    let offset = 0
    if (entry.resumeRequested && size > 0) {
      const partial = await this.opts.local.sizeOf(task.target)
      if (partial !== null && partial > 0 && partial < size) offset = partial
    } else if (!isDirectory && !options.overwrite && (await this.opts.local.exists(task.target))) {
      throw new SftpError('ALREADY_EXISTS', `本地已存在同名文件：${task.target}`, {
        hint: '如需覆盖，请在传输时勾选「覆盖同名文件」。',
      })
    }

    return {
      remotePath: task.source,
      localPath: task.target,
      isDirectory,
      size,
      filesTotal: aggregate ? Math.max(1, aggregate.files) : 1,
      offset,
      mode: options.preserveMode ? remoteEntry.mode : 0o644,
    }
  }

  /** 递归聚合远端目录的大小与文件数 */
  private async measureRemote(input: string, depth = 0): Promise<{ size: number; files: number }> {
    if (depth > 64) return { size: 0, files: 0 }
    const { entry, stats } = await this.opts.remote.lstat(input)
    if (!stats.isDirectory()) return { size: entry.size, files: 1 }

    const { entries } = await this.opts.remote.list(input)
    let size = 0
    let files = 0
    for (const child of entries) {
      if (child.type === 'link') continue
      const measured = await this.measureRemote(child.path, depth + 1)
      size += measured.size
      files += measured.files
    }
    return { size, files }
  }

  /* ------------------------------------------------------------------ */
  /* 执行                                                               */
  /* ------------------------------------------------------------------ */

  private async runFile(entry: InternalTask, plan: TransferPlan): Promise<void> {
    const { task, options } = entry
    const isUpload = task.direction === 'upload'

    const source = isUpload
      ? this.opts.local.createReadStream(plan.localPath, { start: plan.offset })
      : await this.opts.remote.createReadStream(plan.remotePath, { start: plan.offset })

    const dest = isUpload
      ? await this.opts.remote.createWriteStream(plan.remotePath, {
          flags: plan.offset > 0 ? 'r+' : 'w',
          start: plan.offset,
          ...(options.preserveMode && plan.mode > 0 ? { mode: plan.mode } : {}),
        })
      : this.opts.local.createWriteStream(plan.localPath, {
          flags: plan.offset > 0 ? 'r+' : 'w',
          start: plan.offset,
          ...(options.preserveMode && plan.mode > 0 ? { mode: plan.mode } : {}),
        })

    await this.pump(entry, source, dest)
    task.filesDone = 1
  }

  private async runDirectory(entry: InternalTask, plan: TransferPlan): Promise<void> {
    const { task, options } = entry
    const isUpload = task.direction === 'upload'

    // 递归展开成一串「文件 + 需要创建的目录」，
    // 目录先建后传，避免逐个文件再去建父目录
    const items: Array<{ remote: string; local: string; size: number; isDir: boolean; mode: number }> = []
    if (isUpload) {
      await this.opts.remote.mkdirp(plan.remotePath)
      for (const item of await this.opts.local.walk(plan.localPath)) {
        items.push({
          remote: posixJoin(plan.remotePath, item.rel.split(path.sep).join('/')),
          local: item.abs,
          size: item.size,
          isDir: item.isDir,
          mode: item.mode,
        })
      }
    } else {
      await this.opts.local.mkdirp(plan.localPath)
      // 以任务的实际目标路径为基：下载 /home/demo/tree 到 local/tree-back，
      // 结构是 tree-back/tree/...（源目录保留自己的名字，与 cp -r 语义一致）
      await this.walkRemote(plan.remotePath, '', plan.localPath, items)
    }

    task.filesTotal = Math.max(1, items.filter((i) => !i.isDir).length)
    this.emitUpdate(entry)

    for (const item of items) {
      await this.waitIfPaused(entry)
      if (entry.control.cancelRequested) throw new TransferCanceled()

      if (item.isDir) {
        if (isUpload) await this.opts.remote.mkdirp(item.remote)
        else await this.opts.local.mkdirp(item.local)
        continue
      }

      // 目录内单个文件不单独续传：整体任务失败时的续传粒度就是「文件级」，
      // 重试会重新遍历目录，已完整存在的文件因大小一致被跳过
      const already =
        isUpload
          ? await this.opts.remote.sizeOf(item.remote)
          : await this.opts.local.sizeOf(item.local)
      if (already === item.size) {
        task.transferred += item.size
        task.filesDone += 1
        continue
      }

      const source = isUpload
        ? this.opts.local.createReadStream(item.local)
        : await this.opts.remote.createReadStream(item.remote)
      const dest = isUpload
        ? await this.opts.remote.createWriteStream(item.remote, {
            flags: 'w',
            ...(options.preserveMode && item.mode > 0 ? { mode: item.mode } : {}),
          })
        : this.opts.local.createWriteStream(item.local, {
            flags: 'w',
            ...(options.preserveMode && item.mode > 0 ? { mode: item.mode } : {}),
          })

      await this.pump(entry, source, dest)
      task.filesDone += 1
    }
  }

  private async walkRemote(
    dir: string,
    relPrefix: string,
    localBase: string,
    out: Array<{ remote: string; local: string; size: number; isDir: boolean; mode: number }>,
  ): Promise<void> {
    const { entries } = await this.opts.remote.list(dir)
    for (const child of entries) {
      if (child.type === 'link') continue
      const rel = relPrefix === '' ? child.name : `${relPrefix}/${child.name}`
      const local = path.join(localBase, rel.split('/').filter(Boolean).join(path.sep))
      if (child.type === 'dir') {
        out.push({ remote: child.path, local, size: 0, isDir: true, mode: child.mode })
        await this.walkRemote(child.path, rel, localBase, out)
      } else {
        out.push({ remote: child.path, local, size: child.size, isDir: false, mode: child.mode })
      }
    }
  }

  /**
   * 手写拷贝循环。
   *
   * 用 `for await` 从源读取 → 写目标 → 按 drain 反馈做背压，
   * 每一步都能插入暂停与取消检查，这是 `pipe` 做不到的。
   *
   * 目标流的失败必须用「事件 + 信号」两条腿走路，缺一不可：
   *
   * 1. ssh2 的 SFTP 写流在 `_write` 失败时是**先 `this.destroy()` 再 `cb(er)`**。
   *    `destroy()` 会同步把 `writableState.destroyed` 置为 true，随后 Node 的
   *    `errorOrDestroy()` 见流已销毁便直接返回 —— **`error` 事件根本不会发出**，
   *    只有 `_destroy` → `closeStream()` 里的 `stream.emit('close')` 会出现。
   *    所以只监听 `error` 的任务会永久停在 running：既不完成，也不失败。
   * 2. 错误还可能发生在 `write()` 返回之后、我们挂上监听之前。
   *    因此在第一次写入之前就建好 failureSignal，覆盖这个窗口。
   */
  private async pump(entry: InternalTask, source: Readable, dest: Writable): Promise<void> {
    entry.streams = [source, dest]
    const { task, control } = entry

    let failure: Error | undefined
    let rejectOnFailure: ((err: Error) => void) | undefined
    const failureSignal = new Promise<never>((_, reject) => {
      rejectOnFailure = reject
    })
    failureSignal.catch(() => {
      /* 允许无人 await 时不产生未处理拒绝告警 */
    })

    const fail = (err: Error): void => {
      if (failure) return
      failure = err
      rejectOnFailure?.(err)
    }

    // 正常收尾（end() 之后）时 'close' 是成功信号，不能当成失败
    let ending = false
    const onError = (err: Error): void => fail(err)
    const onClose = (): void => {
      // 未进入收尾就被关闭 ⇒ 远端写入失败（见上面的 ssh2 分析）
      if (!ending) fail(new Error('目标流在写入完成前被关闭，远端写入可能已失败'))
    }
    dest.on('error', onError)
    dest.on('close', onClose)

    try {
      for await (const chunk of source) {
        await this.waitIfPaused(entry)
        if (control.cancelRequested) throw new TransferCanceled()
        if (failure) throw failure

        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
        const accepted = dest.write(buf)
        task.transferred += buf.length
        if (!accepted) {
          await Promise.race([once(dest, 'drain'), failureSignal])
        }
      }

      if (failure) throw failure

      // 收尾必须同时接受 'finish' 与 'close'：
      // ssh2 的 SFTP 写流在 `_final` 里先 destroy 再回调，导致 'finish' 不会发出，
      // 只有 'close' 会出现（这也是远端文件句柄真正关闭、数据落盘的时刻）。
      // 而本地 fs.WriteStream 两者都会发。等待任一即可。
      ending = true
      await new Promise<void>((resolve, reject) => {
        const settle = (fn: () => void): void => {
          dest.off('finish', onFinish)
          dest.off('close', onEndClose)
          dest.off('error', onEndError)
          fn()
        }
        const onFinish = (): void => settle(resolve)
        const onEndClose = (): void => settle(resolve)
        const onEndError = (err: Error): void => settle(() => reject(err))
        dest.once('finish', onFinish)
        dest.once('close', onEndClose)
        dest.once('error', onEndError)
        dest.end()
      })
    } finally {
      dest.off('error', onError)
      dest.off('close', onClose)
      entry.streams = []
    }
  }

  private waitIfPaused(entry: InternalTask): Promise<void> {
    if (!entry.control.paused) return Promise.resolve()
    return new Promise<void>((resolve) => {
      entry.control.resumeWaiters.push(resolve)
    })
  }

  private destroyStreams(entry: InternalTask): void {
    for (const stream of entry.streams) {
      try {
        stream.destroy()
      } catch {
        /* 忽略 */
      }
    }
    entry.streams = []
  }

  /** 取消时清理半成品；失败时保留，以便续传 */
  private async cleanupPartial(entry: InternalTask, remove: boolean): Promise<void> {
    if (!remove) return
    const { task } = entry
    if (task.isDirectory) return // 目录是逐个文件写的，无法安全地整体删除

    // 取消的流程是「先 destroy 流，再删文件」，此刻 SFTP 的 CLOSE 往往还没往返完成，
    // 远端句柄仍然打开 —— Windows 上删除一个被打开的文件会直接 EBUSY 失败。
    // 所以这里退避重试若干次，等句柄真正关闭；同时兼顾「目标尚未创建」的情况。
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (attempt > 0) await new Promise<void>((resolve) => setTimeout(resolve, 50))
      try {
        const exists =
          task.direction === 'upload'
            ? await this.opts.remote.exists(task.target)
            : await this.opts.local.exists(task.target)
        if (!exists) return
        if (task.direction === 'upload') await this.opts.remote.unlink(task.target)
        else await this.opts.local.remove(task.target)
        return
      } catch {
        // 句柄可能尚未关闭；重试。仍失败则留下半成品，不影响用户
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 进度上报与清理                                                      */
  /* ------------------------------------------------------------------ */

  private tickProgress(): void {
    const now = Date.now()
    for (const entry of this.tasks.values()) {
      if (entry.task.state !== 'running') continue
      const samples = entry.samples
      samples.push({ at: now, bytes: entry.task.transferred })
      while (samples.length > SFTP_SPEED_WINDOW) samples.shift()

      const first = samples[0]
      const last = samples[samples.length - 1]
      if (first && last && last.at > first.at) {
        const speed = ((last.bytes - first.bytes) * 1000) / (last.at - first.at)
        entry.task.speed = Math.max(0, Math.round(speed))
        const remaining = entry.task.size - entry.task.transferred
        entry.task.etaSec =
          entry.task.speed > 0 && remaining > 0 ? Math.ceil(remaining / entry.task.speed) : null
      }
      this.emit('update', { ...entry.task })
    }
  }

  private emitUpdate(entry: InternalTask): void {
    this.emit('update', { ...entry.task })
  }

  private drop(taskId: string): void {
    this.tasks.delete(taskId)
    const index = this.order.indexOf(taskId)
    if (index !== -1) this.order.splice(index, 1)
    this.emit('removed', taskId)
  }

  /** 终态任务保留一段时间供用户查看结果，之后自动清理 */
  private pruneFinished(): void {
    const cutoff = Date.now() - SFTP_TRANSFER_RETENTION_MS
    for (const [id, entry] of [...this.tasks.entries()]) {
      const { state, finishedAt } = entry.task
      if (state === 'done' || state === 'failed' || state === 'canceled') {
        if (finishedAt && new Date(finishedAt).getTime() < cutoff) {
          this.drop(id)
        }
      }
    }
  }
}
