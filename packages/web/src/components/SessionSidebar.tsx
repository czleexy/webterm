/**
 * 会话树侧边栏。
 * 阶段 0 只有骨架；阶段 2 接入 folders / sessions 数据后填充真实内容。
 */
export function SessionSidebar() {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-neutral-200 px-3 dark:border-neutral-800">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
          会话
        </span>
        <span className="rounded border border-dashed border-neutral-300 px-1.5 py-px text-[10px] text-neutral-400 dark:border-neutral-700 dark:text-neutral-500">
          阶段 2
        </span>
      </div>

      <div className="p-2">
        <input
          type="search"
          disabled
          placeholder="搜索会话…"
          className="w-full rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-xs text-neutral-900 placeholder:text-neutral-400 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-600"
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
        <svg viewBox="0 0 24 24" className="size-8 text-neutral-300 dark:text-neutral-700" aria-hidden="true">
          <path
            d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l1.6 2H19.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
        <p className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
          暂无会话
          <br />
          会话管理将在阶段 2 交付
        </p>
      </div>
    </aside>
  )
}
