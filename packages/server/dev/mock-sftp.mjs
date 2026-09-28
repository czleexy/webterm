/**
 * 开发用 SFTP 服务端实现（挂在 mock-ssh-server.mjs 的 sftp 子系统上）。
 *
 * 用途：真机 `192.168.1.254` 拒绝 shell/exec/subsystem，无法验证文件传输链路。
 * 这里用 ssh2 的「服务端模式」自己实现一个 SFTP 后端，把请求落到本地磁盘上，
 * 从而让上传、下载、断点续传、递归目录、chmod 等能力可以被端到端验证。
 *
 * 两个刻意的取舍：
 *
 * 1. **权限位在内存里记账**。Windows 的 chmod 只支持只读位，`stat` 回读的 mode
 *    是合成值，无法断言 644/755。这里用一个 per-path 的权限表覆盖回给客户端，
 *    让「客户端改权限 → 服务端记录 → 再读回」这条链路在任何平台都可验证；
 *    真实主机上这条链路是设备自己维护的，行为只会更标准。
 * 2. **虚拟家目录 `/home/demo`**。客户端会用 realpath('.') 拿初始目录，
 *    这里返回虚拟路径并把它映射到 root，其它绝对路径也一并映射进 root，
 *    保证测试用的文件永远落在临时目录里，不会误伤宿主文件系统。
 *
 * 故障注入：环境变量 `MOCK_SFTP_FAIL_ONCE_AFTER=<字节数>` 会在累计写入超过该字节数后
 * **一次性**返回 FAILURE，用于验证断点续传 —— 这是唯一能稳定复现「传到一半断了」的手段，
 * 否则只能靠真的拔网线。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 一次性故障阈值：累计写入超过它就失败一次，然后自动解除 */
const FAIL_ONCE_AFTER = Number(process.env.MOCK_SFTP_FAIL_ONCE_AFTER || 0)
let writtenBytes = 0
let faultArmed = FAIL_ONCE_AFTER > 0

const STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  OP_UNSUPPORTED: 8,
}

/** SSH_FXF_* 打开标志 */
const OPEN = {
  READ: 0x00000001,
  WRITE: 0x00000002,
  APPEND: 0x00000004,
  CREAT: 0x00000008,
  TRUNC: 0x00000010,
  EXCL: 0x00000020,
}

const TYPE_DIR = 0o040000
const TYPE_FILE = 0o100000
const TYPE_LINK = 0o120000

/** 虚拟家目录；客户端 realpath('.') 会拿到它 */
const VIRTUAL_HOME = '/home/demo'

export function attachSftpServer(sftp, root, log = () => {}) {
  const handles = new Map()
  /** 内存权限表：绝对虚拟路径 → 权限位 */
  const modeOverrides = new Map()
  let nextHandle = 1

  const allocHandle = (value) => {
    const id = nextHandle++
    handles.set(id, value)
    return id
  }
  const handleBuf = (id) => {
    const buf = Buffer.allocUnsafe(4)
    buf.writeUInt32BE(id, 0)
    return buf
  }
  const handleId = (buf) => (Buffer.isBuffer(buf) ? buf.readUInt32BE(0) : -1)
  const getHandle = (buf) => handles.get(handleId(buf))

  /** 虚拟路径 → 宿主路径；越界一律夹回 root 之内 */
  const toHost = (virtualPath) => {
    const normalized = normalizePosix(virtualPath)
    let relative = normalized
    if (normalized === VIRTUAL_HOME) relative = '/'
    else if (normalized.startsWith(`${VIRTUAL_HOME}/`)) {
      relative = normalized.slice(VIRTUAL_HOME.length)
    }
    const segments = relative.split('/').filter((s) => s.length > 0 && s !== '.')
    const out = []
    for (const segment of segments) {
      if (segment === '..') {
        out.pop()
        continue
      }
      out.push(segment)
    }
    return path.join(root, ...out)
  }

  /** 宿主路径 → 虚拟路径（家目录之外的部分也能反向表示） */
  const toVirtual = (hostPath) => {
    const rel = path.relative(root, hostPath)
    if (rel === '') return VIRTUAL_HOME
    return `${VIRTUAL_HOME}/${rel.split(path.sep).join('/')}`
  }

  const modeOf = (hostPath, stats) => {
    const virtual = toVirtual(hostPath)
    const override = modeOverrides.get(virtual)
    if (override !== undefined) {
      return (stats.isDirectory() ? TYPE_DIR : TYPE_FILE) | override
    }
    // 无覆盖时给 POSIX 常规默认值，而不是回读宿主 Windows 的合成 mode ——
    // 后者不稳定（只读位会影响回读结果），会让断言变得不可靠
    return (stats.isDirectory() ? TYPE_DIR : TYPE_FILE) | (stats.isDirectory() ? 0o755 : 0o644)
  }

  const attrsOf = (hostPath, stats, lstat = false) => ({
    mode: modeOf(hostPath, stats),
    uid: 1000,
    gid: 1000,
    size: lstat && stats.isSymbolicLink() ? 0 : stats.size,
    atime: stats.atime,
    mtime: stats.mtime,
  })

  const longnameOf = (name, stats, mode) => {
    const typeChar = stats.isDirectory() ? 'd' : stats.isSymbolicLink() ? 'l' : '-'
    const perm = [8, 7, 6, 5, 4, 3, 2, 1, 0]
      .map((shift) => {
        const bit = 1 << shift
        const index = (8 - shift) % 3
        return mode & bit ? ['r', 'w', 'x'][index] : '-'
      })
      .join('')
    const size = String(stats.size).padStart(10)
    return `${typeChar}${perm} 1 demo demo ${size} ${stats.mtime.toDateString()} ${name}`
  }

  const fail = (reqid, code, message) => sftp.status(reqid, code, message)

  const withStat = (reqid, hostPath, lstat, respond) => {
    const fn = lstat ? fs.lstat : fs.stat
    fn(hostPath, (err, stats) => {
      if (err) return fail(reqid, STATUS.NO_SUCH_FILE, err.message)
      try {
        respond(stats)
      } catch (e) {
        fail(reqid, STATUS.FAILURE, e.message)
      }
    })
  }

  /* ---------------- 请求处理 ---------------- */

  sftp.on('REALPATH', (reqid, virtualPath) => {
    const host = toHost(virtualPath)
    fs.stat(host, (err) => {
      if (err) return fail(reqid, STATUS.NO_SUCH_FILE, err.message)
      const virtual = toVirtual(host)
      log(`[sftp] REALPATH ${virtualPath} -> ${virtual}`)
      sftp.name(reqid, [{ filename: virtual, longname: virtual }])
    })
  })

  sftp.on('STAT', (reqid, virtualPath) => {
    withStat(reqid, toHost(virtualPath), false, (stats) =>
      sftp.attrs(reqid, attrsOf(toHost(virtualPath), stats)),
    )
  })

  sftp.on('LSTAT', (reqid, virtualPath) => {
    withStat(reqid, toHost(virtualPath), true, (stats) =>
      sftp.attrs(reqid, attrsOf(toHost(virtualPath), stats, true)),
    )
  })

  sftp.on('FSTAT', (reqid, handle) => {
    const entry = getHandle(handle)
    if (!entry || entry.kind !== 'file') return fail(reqid, STATUS.FAILURE, 'invalid handle')
    fs.fstat(entry.fd, (err, stats) => {
      if (err) return fail(reqid, STATUS.FAILURE, err.message)
      sftp.attrs(reqid, attrsOf(entry.hostPath, stats))
    })
  })

  sftp.on('OPENDIR', (reqid, virtualPath) => {
    const host = toHost(virtualPath)
    fs.readdir(host, { withFileTypes: true }, (err, dirents) => {
      if (err) return fail(reqid, STATUS.NO_SUCH_FILE, err.message)
      const entries = []
      // 真实服务端会带上 . 与 ..；客户端会自行过滤
      fs.stat(host, (statErr, selfStats) => {
        if (!statErr) {
          entries.push({ name: '.', stats: selfStats })
          entries.push({ name: '..', stats: selfStats })
        }
        let pending = dirents.length
        const done = () => {
          if (pending > 0) return
          const id = allocHandle({ kind: 'dir', entries, sent: false, hostPath: host })
          log(`[sftp] OPENDIR ${virtualPath} (${entries.length} 项)`)
          sftp.handle(reqid, handleBuf(id))
        }
        if (pending === 0) return done()
        for (const dirent of dirents) {
          fs.lstat(path.join(host, dirent.name), (lsErr, stats) => {
            if (!lsErr) entries.push({ name: dirent.name, stats })
            pending -= 1
            done()
          })
        }
      })
    })
  })

  sftp.on('READDIR', (reqid, handle) => {
    const entry = getHandle(handle)
    if (!entry || entry.kind !== 'dir') return fail(reqid, STATUS.FAILURE, 'invalid dir handle')
    // 客户端会反复调用直到收到 EOF，这里一次给完
    if (entry.sent) return fail(reqid, STATUS.EOF, 'end of directory')
    entry.sent = true
    sftp.name(
      reqid,
      entry.entries.map((item) => {
        const childHost = path.join(entry.hostPath, item.name)
        const mode = modeOf(childHost, item.stats)
        return {
          filename: item.name,
          longname: longnameOf(item.name, item.stats, mode & 0o7777),
          attrs: attrsOf(childHost, item.stats),
        }
      }),
    )
  })

  sftp.on('OPEN', (reqid, virtualPath, pflags, _attrs) => {
    const host = toHost(virtualPath)
    const exists = fs.existsSync(host)

    if (pflags & OPEN.EXCL && pflags & OPEN.CREAT && exists) {
      return fail(reqid, STATUS.FAILURE, 'file exists')
    }
    if (pflags & OPEN.CREAT && !exists) {
      try {
        fs.closeSync(fs.openSync(host, 'w'))
      } catch (err) {
        return fail(reqid, STATUS.PERMISSION_DENIED, err.message)
      }
    }

    let flags = 'r+'
    if (!exists && !(pflags & OPEN.CREAT)) {
      return fail(reqid, STATUS.NO_SUCH_FILE, `${virtualPath} not found`)
    }
    if (pflags & OPEN.APPEND) flags = 'a'
    else if (pflags & OPEN.WRITE && !(pflags & OPEN.READ) && !(pflags & OPEN.TRUNC)) flags = 'r+'
    else if (!(pflags & OPEN.WRITE) && pflags & OPEN.READ) flags = 'r'

    fs.open(host, flags, (err, fd) => {
      if (err) return fail(reqid, STATUS.PERMISSION_DENIED, err.message)
      const finish = () => {
        const id = allocHandle({ kind: 'file', fd, hostPath: host, virtualPath: toVirtual(host) })
        sftp.handle(reqid, handleBuf(id))
      }
      if (pflags & OPEN.TRUNC) {
        fs.ftruncate(fd, 0, (truncErr) => {
          if (truncErr) {
            fs.close(fd, () => {})
            return fail(reqid, STATUS.FAILURE, truncErr.message)
          }
          finish()
        })
      } else {
        finish()
      }
    })
  })

  sftp.on('READ', (reqid, handle, offset, len) => {
    const entry = getHandle(handle)
    if (!entry || entry.kind !== 'file') return fail(reqid, STATUS.FAILURE, 'invalid handle')
    const buf = Buffer.allocUnsafe(len)
    fs.read(entry.fd, buf, 0, len, offset, (err, bytesRead) => {
      if (err) return fail(reqid, STATUS.FAILURE, err.message)
      if (bytesRead === 0) return fail(reqid, STATUS.EOF, 'eof')
      sftp.data(reqid, bytesRead === len ? buf : buf.subarray(0, bytesRead))
    })
  })

  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const entry = getHandle(handle)
    if (!entry || entry.kind !== 'file') return fail(reqid, STATUS.FAILURE, 'invalid handle')

    if (faultArmed && writtenBytes >= FAIL_ONCE_AFTER) {
      faultArmed = false
      log(`[sftp] 注入故障：累计写入 ${writtenBytes} 字节后拒绝本次 WRITE`)
      return fail(reqid, STATUS.FAILURE, 'injected write failure')
    }
    writtenBytes += data.length

    fs.write(entry.fd, data, 0, data.length, offset, (err) => {
      if (err) return fail(reqid, STATUS.FAILURE, err.message)
      sftp.status(reqid, STATUS.OK)
    })
  })

  sftp.on('CLOSE', (reqid, handle) => {
    const entry = getHandle(handle)
    if (!entry) return fail(reqid, STATUS.FAILURE, 'invalid handle')
    handles.delete(handleId(handle))
    if (entry.kind === 'file') {
      fs.close(entry.fd, (err) => {
        if (err) fail(reqid, STATUS.FAILURE, err.message)
        else sftp.status(reqid, STATUS.OK)
      })
    } else {
      sftp.status(reqid, STATUS.OK)
    }
  })

  const applyAttrs = (reqid, hostPath, attrs, done) => {
    const steps = []
    if (typeof attrs.mode === 'number' && (attrs.mode & 0o7777) !== 0) {
      modeOverrides.set(toVirtual(hostPath), attrs.mode & 0o7777)
      steps.push((next) => fs.chmod(hostPath, attrs.mode & 0o7777, () => next()))
    }
    if (attrs.mtime !== undefined) {
      const mtime = attrs.mtime instanceof Date ? attrs.mtime : new Date(Number(attrs.mtime) * 1000)
      const atime = attrs.atime instanceof Date ? attrs.atime : mtime
      steps.push((next) => fs.utimes(hostPath, atime, mtime, () => next()))
    }
    let index = 0
    const runNext = () => {
      const step = steps[index]
      index += 1
      if (!step) return done()
      step(runNext)
    }
    runNext()
  }

  sftp.on('SETSTAT', (reqid, virtualPath, attrs) => {
    const host = toHost(virtualPath)
    log(`[sftp] SETSTAT ${virtualPath} ${JSON.stringify({ mode: attrs.mode, mtime: attrs.mtime })}`)
    applyAttrs(reqid, host, attrs, () => sftp.status(reqid, STATUS.OK))
  })

  sftp.on('FSETSTAT', (reqid, handle, attrs) => {
    const entry = getHandle(handle)
    if (!entry || entry.kind !== 'file') return fail(reqid, STATUS.FAILURE, 'invalid handle')
    applyAttrs(reqid, entry.hostPath, attrs, () => sftp.status(reqid, STATUS.OK))
  })

  sftp.on('MKDIR', (reqid, virtualPath, attrs) => {
    const host = toHost(virtualPath)
    const mode = attrs && typeof attrs.mode === 'number' ? attrs.mode & 0o7777 : 0o755
    fs.mkdir(host, (err) => {
      if (err) return fail(reqid, STATUS.FAILURE, err.message)
      modeOverrides.set(toVirtual(host), mode)
      log(`[sftp] MKDIR ${virtualPath}`)
      sftp.status(reqid, STATUS.OK)
    })
  })

  sftp.on('RMDIR', (reqid, virtualPath) => {
    fs.rmdir(toHost(virtualPath), (err) => {
      if (err) return fail(reqid, STATUS.FAILURE, err.message)
      modeOverrides.delete(normalizePosix(virtualPath))
      sftp.status(reqid, STATUS.OK)
    })
  })

  sftp.on('REMOVE', (reqid, virtualPath) => {
    fs.unlink(toHost(virtualPath), (err) => {
      if (err) return fail(reqid, STATUS.NO_SUCH_FILE, err.message)
      modeOverrides.delete(normalizePosix(virtualPath))
      sftp.status(reqid, STATUS.OK)
    })
  })

  sftp.on('RENAME', (reqid, oldPath, newPath) => {
    const from = toHost(oldPath)
    const to = toHost(newPath)
    fs.rename(from, to, (err) => {
      if (err) return fail(reqid, STATUS.FAILURE, err.message)
      const override = modeOverrides.get(toVirtual(from))
      if (override !== undefined) {
        modeOverrides.delete(toVirtual(from))
        modeOverrides.set(toVirtual(to), override)
      }
      log(`[sftp] RENAME ${oldPath} -> ${newPath}`)
      sftp.status(reqid, STATUS.OK)
    })
  })

  sftp.on('READLINK', (reqid, virtualPath) => {
    fs.readlink(toHost(virtualPath), (err, target) => {
      if (err) return fail(reqid, STATUS.NO_SUCH_FILE, err.message)
      sftp.name(reqid, [{ filename: target, longname: target }])
    })
  })

  sftp.on('SYMLINK', (reqid, targetPath, linkPath) => {
    const target = toHost(targetPath)
    const link = toHost(linkPath)
    fs.symlink(target, link, 'file', (err) => {
      if (err) return fail(reqid, STATUS.FAILURE, err.message)
      sftp.status(reqid, STATUS.OK)
    })
  })

  sftp.on('EXTENDED', (reqid) => fail(reqid, STATUS.OP_UNSUPPORTED, 'extended request unsupported'))

  sftp.on('close', () => {
    for (const [, entry] of handles) {
      if (entry.kind === 'file') fs.close(entry.fd, () => {})
    }
    handles.clear()
  })
}

function normalizePosix(input) {
  const absolute = input.startsWith('/')
  const out = []
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      out.pop()
      continue
    }
    out.push(segment)
  }
  const joined = out.join('/')
  return absolute ? `/${joined}` : joined
}
