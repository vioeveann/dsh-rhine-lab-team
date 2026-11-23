/**
 * Client half of the dsh-team bundle (S0 spike).
 *
 * Registers three things:
 *  1. a `member` fence layer, so a ```member block renders as a member card;
 *  2. a team toggle in the New Session row (`conversation.hero.options`);
 *  3. the same toggle below the composer (`conversation.composer.dock`).
 *
 * The card is a pure function of the fence text: the session log keeps the raw
 * code block, so nothing here can corrupt the transcript.
 */
window.__ModuleLoader__.load({
  id: 'dsh-rhine-lab-team',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 给离线测试伸进去的把手；正常运行时是空的。 */
    const internals = {}

    /**
     * 子会话 → Bot 的映射。聊天行只拿到 sessionId，靠这张表认出是谁在说话。
     * 每 8 秒刷一次，和成员面板同一个接口。
     */
  const DIAG_URL = '/dsh-team/diag'

  /** 把关键节点报给主进程的调试日志；失败就算了，不能影响界面。 */
  function reportDiag(payload) {
    try {
      void fetch(DIAG_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {})
    } catch {
      // 忽略
    }
  }

    const teamSessions = new Map()
    let teamSessionsAt = 0

    /** 拉一次名册，记下每个后代会话对应的 Bot。 */
    async function refreshTeamSessions() {
      if (Date.now() - teamSessionsAt < 8000) return
      teamSessionsAt = Date.now()
      try {
        const response = await fetch('/dsh-team/roster')
        const data = await response.json()
        teamSessions.clear()
        for (const member of data?.members ?? []) {
          if (member?.sessionId) {
            teamSessions.set(member.sessionId, {
              id: member.id,
              name: member.name ?? member.id,
              role: member.role ?? '',
            })
          }
        }
      } catch {
        // 主进程没起来：保持上一次的映射。
      }
    }

    /** member 卡片要的名字 / 头像 / 等级：来自名册，缓存 8 秒。 */
    const memberInfo = { at: 0, byId: new Map() }

    /**
     * 取一个成员的名册信息；拿不到就返回 null，卡片退回围栏里的字段。
     * @param id - Bot id。
     */
    async function loadMemberInfo(id) {
      if (Date.now() - memberInfo.at > 8000) {
        memberInfo.at = Date.now()
        try {
          const response = await fetch('/dsh-team/roster')
          const data = await response.json()
          memberInfo.byId.clear()
          for (const member of data?.members ?? []) {
            if (member?.id) memberInfo.byId.set(member.id, member)
          }
        } catch {
          // 保留旧缓存：离线时卡片还能显示上次的名字。
        }
      }
      return memberInfo.byId.get(id) ?? null
    }

    /**
     * Bot 一交活就往会话框右下角弹一张卡，不等这一轮收尾再贴 markdown。
     * 数据来自 SSE 的 task-done 事件（host 在任务结算时广播）。
     * @param payload - `{ taskId, bot, status, text }`。
     */
    const showLiveCard = (payload) => {
      if (!payload || !payload.taskId || !payload.bot) return
      if (typeof document === 'undefined' || !document.body) return
      const taskId = String(payload.taskId)
      const botId = String(payload.bot)
      const status = String(payload.status ?? 'ready')
      const text = String(payload.text ?? '').trim()

      let layer = document.getElementById('dsh-team-live-cards')
      if (!layer) {
        layer = document.createElement('div')
        layer.id = 'dsh-team-live-cards'
        layer.style.cssText = [
          'position:fixed',
          'right:24px',
          'bottom:96px',
          'z-index:2147483000',
          'display:flex',
          'flex-direction:column',
          'gap:10px',
          'align-items:flex-end',
          'pointer-events:none',
        ].join(';')
        document.body.appendChild(layer)
      }

      const tone = {
        good: '#3f7d46',
        bad: '#b4472f',
        warn: '#a8762a',
        active: '#4a6fa5',
        muted: '#8a8474',
      }
      const toneOf = (name) => tone[STATUS[name]?.tone] ?? tone.muted
      const statusLabel = STATUS[status]?.label ?? STATUS.ready.label

      // 同一件活只留一张：后来的覆盖状态和正文，不重复叠卡。
      const existing = layer.querySelector(`[data-task-id="${taskId.replace(/"/g, '')}"]`)
      if (existing) {
        const pill = existing.querySelector('[data-role="status"]')
        if (pill) {
          pill.textContent = statusLabel
          pill.style.color = toneOf(status)
          pill.style.borderColor = toneOf(status)
        }
        const body = existing.querySelector('[data-role="text"]')
        if (body && text) body.textContent = text
        return
      }

      const card = document.createElement('div')
      card.dataset.taskId = taskId
      card.style.cssText = [
        'pointer-events:auto',
        'width:min(420px, calc(100vw - 48px))',
        'box-sizing:border-box',
        'background:#fbf6ea',
        'border:1px solid #d8cdb8',
        'border-radius:16px',
        'box-shadow:0 10px 30px rgba(60, 45, 20, 0.18)',
        'padding:14px 16px 12px',
        'color:#2c2618',
        'font-family:inherit',
        'opacity:0',
        'transform:translateY(8px)',
        'transition:opacity .18s ease, transform .18s ease',
      ].join(';')

      const head = document.createElement('div')
      head.style.cssText = 'display:flex;align-items:center;gap:10px;'

      const avatar = document.createElement('img')
      avatar.src = `/dsh-team/avatar?bot=${encodeURIComponent(botId)}&v=3`
      avatar.alt = botId
      avatar.style.cssText = 'width:44px;height:44px;border-radius:12px;object-fit:cover;flex:0 0 auto;'

      const who = document.createElement('div')
      who.style.cssText = 'min-width:0;flex:1;'
      const name = document.createElement('div')
      name.style.cssText = 'font-size:15px;font-weight:700;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
      name.textContent = botId
      const role = document.createElement('div')
      role.style.cssText = 'font-size:12px;color:#7a715e;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
      role.textContent = `@${botId}`
      who.append(name, role)

      const pill = document.createElement('span')
      pill.dataset.role = 'status'
      pill.textContent = statusLabel
      pill.style.cssText = [
        `color:${toneOf(status)}`,
        `border:1px solid ${toneOf(status)}`,
        'border-radius:999px',
        'padding:2px 10px',
        'font-size:12px',
        'line-height:1.6',
        'flex:0 0 auto',
        'background:rgba(255,255,255,.5)',
      ].join(';')

      const close = document.createElement('button')
      close.type = 'button'
      close.textContent = '×'
      close.title = '关闭'
      close.style.cssText = 'border:0;background:transparent;color:#9a907a;font-size:18px;line-height:1;cursor:pointer;padding:0 2px;flex:0 0 auto;'
      close.onclick = () => card.remove()

      head.append(avatar, who, pill, close)

      const body = document.createElement('div')
      body.dataset.role = 'text'
      body.style.cssText = 'margin-top:10px;font-size:14px;line-height:1.65;white-space:pre-wrap;word-break:break-word;max-height:150px;overflow:hidden;'
      body.textContent = text || '（没有正文）'

      const foot = document.createElement('div')
      foot.style.cssText = 'margin-top:8px;font-size:12px;color:#9a907a;'
      foot.textContent = taskId

      card.append(head, body, foot)
      layer.appendChild(card)

      // 最多同时 4 张，多了先撤最老的。
      const cards = layer.querySelectorAll('[data-task-id]')
      if (cards.length > 4) cards[0].remove()

      void requestAnimationFrame(() => {
        card.style.opacity = '1'
        card.style.transform = 'translateY(0)'
      })

      // 头像和名字从成员表补齐；拿不到就用 id 顶着。
      void loadMemberInfo(botId).then((info) => {
        if (!info) return
        if (info.name) name.textContent = info.name
        role.textContent = info.role ? `@${botId} · ${info.role}` : `@${botId}`
      })

      setTimeout(() => card.remove(), 120_000)
    }

    const STATUS = {
      queued: { label: '排队中', tone: 'muted' },
      running: { label: '进行中', tone: 'active' },
      progress: { label: '进展', tone: 'muted' },
      'needs-decision': { label: '等你拍板', tone: 'warn' },
      ready: { label: '等你验收', tone: 'good' },
      accepted: { label: '通过', tone: 'good' },
      rejected: { label: '打回', tone: 'bad' },
      blocked: { label: '受阻', tone: 'warn' },
      failed: { label: '失败', tone: 'bad' },
      cancelled: { label: '已取消', tone: 'muted' },
      timeout: { label: '超时', tone: 'warn' },
    }

    /**
     * 唯一一套配色：跟着宿主设计令牌走，不写死主题色。
     * 客户端 bundle 是一个 classic script，所以取值放这里而不是样式表。
     */
    const PALETTE = {
      bg: 'transparent',
      panel: 'transparent',
      surface: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.07))',
      raised: 'var(--dsw-alias-bg-layer-4, rgba(128, 128, 128, 0.18))',
      line: 'var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.24))',
      text: 'var(--dsw-alias-label-primary, #e6e6e6)',
      dim: 'var(--dsw-alias-label-secondary, #a8adb5)',
      faint: 'var(--dsw-alias-label-tertiary, #7d838c)',
      accent: 'var(--dsw-alias-accent, #4a9eff)',
      accentSoft: 'var(--dsw-alias-success, #3fb950)',
      third: 'var(--dsw-alias-danger, #f85149)',
      warn: 'var(--dsw-alias-warning, #d29922)',
      good: 'var(--dsw-alias-success, #3fb950)',
      danger: 'var(--dsw-alias-danger, #f85149)',
      ink: 'var(--dsw-alias-label-on-accent, #ffffff)',
      radius: 6,
    }

    /**
     * 当前配色。
     * @returns 唯一的调色板。
     */
    /**
     * 只有一套皮肤：点按钮时把存过的旧值盖成 classic，免得老值留在 localStorage 里。
     */
    function pinSkinChoice() {
      try {
        globalThis.localStorage?.setItem('dsh-team:skin', 'classic')
      } catch {
        // 私密模式：写不进去就算了，反正只有一套。
      }
    }

    function palette() {
      return PALETTE
    }

    /**
     * 组件问「现在哪套皮肤」。只有一套，留这个钩子是为了组件不用改结构。
     * @returns 固定 'classic'。
     */
    function useSkin() {
      return 'classic'
    }

    /**
     * Status tones. Getters so a skin switch repaints without remounting.
     */
    const TONE = {
      get muted() {
        return palette().dim
      },
      get active() {
        return palette().accent
      },
      get good() {
        return palette().good
      },
      get warn() {
        return palette().warn
      },
      get bad() {
        return palette().danger
      },
    }

    /**
     * Parse the tiny YAML subset used by a `member` fence.
     * Unknown lines are ignored; a missing body falls back to the whole code.
     * @param code - raw fence content.
     * @returns `{ id, role, status, task, dir, body }`
     */
    function parseMember(code) {
      const fields = {}
      const body = []
      let inBody = false
      for (const raw of String(code ?? '').split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, '')
        if (inBody) {
          body.push(line)
          continue
        }
        const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
        if (!match) continue
        const key = match[1].toLowerCase()
        const value = match[2].trim()
        if (key === 'body') {
          if (value) body.push(value)
          inBody = true
          continue
        }
        fields[key] = value
      }
      const text = body.join('\n').trim()
      return {
        id: fields.id || 'bot',
        role: fields.role || '',
        status: fields.status || '',
        task: fields.task || '',
        dir: fields.dir || '',
        body: text || String(code ?? '').trim(),
      }
    }

    function initials(name) {
      const clean = String(name || '?').trim()
      return clean.slice(0, 1).toUpperCase()
    }

    /**
     * Member card rendered in place of a ```member code block.
     * @param props - the fence slot props: `{ code, lang, streaming, children }`.
     */
    function MemberCard({ code, streaming, children }) {
      // Subscribe so a skin switch repaints mounted cards and panels.
      const skin = useSkin()
      const data = parseMember(code)
      const [member, setMember] = React.useState(null)
      const [liveTask, setLiveTask] = React.useState(null)
      const [avatarFailed, setAvatarFailed] = React.useState(false)
      React.useEffect(() => {
        let alive = true
        void loadMemberInfo(data.id).then((hit) => {
          if (alive) setMember(hit)
        })
        // 围栏里的状态是写历史文本时的快照：能查到账本就显示现在的状态。
        if (/^t-[A-Za-z0-9-]+$/.test(data.task)) {
          fetch(`/dsh-team/task?taskId=${encodeURIComponent(data.task)}`)
            .then((response) => response.json())
            .then((body) => {
              if (alive && body?.task) setLiveTask(body.task)
            })
            .catch(() => {})
        }
        return () => {
          alive = false
        }
      }, [data.id, data.task])
      // While the message streams the card would flicker on partial YAML.
      if (streaming) return children
      const statusKey = liveTask?.status ?? data.status
      const status = STATUS[statusKey] ?? { label: statusKey || '—', tone: 'muted' }
      const name = member?.name ?? data.id
      const role = member?.role ?? data.role
      const note = member?.note ?? ''
      const stars = Math.min(5, Math.max(0, Number(member?.stars) || 0))
      const rankLabel = member?.label ?? ''
      const level = Number(member?.lv) || 0
      const tokens = Number(liveTask?.tokens?.total) || 0
      const p = palette()

      const avatarNode = !avatarFailed
        ? h('img', {
            src: `/dsh-team/avatar?bot=${encodeURIComponent(data.id)}&v=3`,
            alt: '',
            loading: 'lazy',
            decoding: 'async',
            draggable: false,
            onError: () => setAvatarFailed(true),
            style: {
              flex: '0 0 auto',
              width: 44,
              height: 44,
              borderRadius: '50%',
              objectFit: 'cover',
              background: p.raised,
            },
          })
        : h(
            'div',
            {
              'aria-hidden': true,
              style: {
                flex: '0 0 auto',
                width: 44,
                height: 44,
                borderRadius: '50%',
                display: 'grid',
                placeItems: 'center',
                fontSize: 17,
                fontWeight: 600,
                color: '#fff',
                background: TONE[status.tone],
              },
            },
            initials(name),
          )

      return h(
        'div',
        {
          'data-dsh-team-card': data.id,
          'data-dsh-team-skin': skin,
          style: {
            display: 'flex',
            gap: 12,
            alignItems: 'flex-start',
            padding: '12px 14px',
            margin: '8px 0',
            borderRadius: 10,
            border: `1px solid ${p.line}`,
            background: p.surface,
            fontSize: 13,
            lineHeight: 1.6,
          },
        },
        avatarNode,
        h(
          'div',
          {
            style: {
              minWidth: 0,
              flex: '1 1 auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' } },
            h('span', { style: { fontWeight: 650, fontSize: 14 } }, name),
            h('span', { style: { color: p.dim, fontSize: 12 } }, `@${data.id}`),
            role ? h('span', { style: { color: p.faint, fontSize: 12 } }, `· ${role}`) : null,
            h(
              'span',
              {
                style: {
                  marginLeft: 'auto',
                  fontSize: 11,
                  padding: '1px 8px',
                  borderRadius: 999,
                  color: TONE[status.tone],
                  border: `1px solid ${TONE[status.tone]}`,
                  whiteSpace: 'nowrap',
                },
              },
              status.label,
            ),
          ),
          note
            ? h(
                'div',
                {
                  style: {
                    color: p.faint,
                    fontSize: 11,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                note,
              )
            : null,
          h(
            'div',
            { style: { marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
            data.body,
          ),
          h(
            'div',
            { style: { marginTop: 8, display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11, color: p.faint } },
            data.task ? h('span', null, data.task) : null,
            stars > 0 ? h('span', { style: { color: p.warn } }, '★'.repeat(stars)) : null,
            rankLabel
              ? h(
                  'span',
                  null,
                  `${rankLabel}${level > 0 && !/Lv\.?\s*\d+/i.test(rankLabel) ? ` Lv.${level}` : ''}`,
                )
              : null,
            tokens > 0 ? h('span', null, tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tok` : `${tokens} tok`) : null,
          ),
        ),
      )
    }

    /**
     * Team toggle. Session scope: the flag lives in a module map keyed by the
     * session id the slot props expose, and is mirrored into localStorage so a
     * page refresh keeps it. Two sessions never share a flag.
     */
    function useTeamFlag(props) {
      const sessionId = resolveSessionId(props)
      const [on, setOn] = React.useState(() => readFlag(sessionId))
      React.useEffect(() => {
        setOn(readFlag(sessionId))
      }, [sessionId])
      const toggle = React.useCallback(() => {
        const next = !readFlag(sessionId)
        writeFlag(sessionId, next)
        setOn(next)
        // 打开团队协作：把成员面板推到右栏（失败也不影响开关本身）。
        if (next) openMembersPane()
        void reportTeamMode(sessionId, next)
        try {
          props?.onTeamToggle?.(next)
        } catch {
          // Callers may not pass a handler; the HTTP report is the real path.
        }
      }, [sessionId, props])
      return [on, toggle]
    }

    /**
     * Tell the host about this session's switch. Failure is silent: the local
     * flag still flips, and the host keeps the previous state.
     */
    async function reportTeamMode(sessionId, on) {
      if (!sessionId || sessionId === 'unknown') return
      try {
        await fetch('/dsh-team/team-mode', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, on }),
        })
      } catch {
        // Offline or blocked: the toggle stays local until the next change.
      }
    }

    /**
     * 把右栏切到「成员」页。拿不到侧栏接口就静默放弃。
     * @returns 是否成功切过去。
     */
    /**
     * 取一个客户端服务：先问 host.get，再看 host 上的属性，最后看 window 上有没有同名入口。
     * @param name - 服务名，例如 sidebarRight。
     */
    /**
     * 打开成员页的实现由 createMembersPanel 装上——只有那里面才有 ctx（host），
     * 工厂作用域里没有，直接写在这里会静默失败。
     */
    let openMembersPaneImpl = () => false

    /**
     * 打不开成员页时，把原因交给面板显示（面板挂载时注册）。
     * 拿不到侧栏服务是「版本不匹配」的典型症状，不能静默。
     */
    let onMembersPaneFailed = null

    /**
     * 打开右栏并切到「成员」页。任何异常都吞掉：这个动作不能把界面搞崩。
     * @returns 是否试着打开了。
     */
    function openMembersPane() {
      try {
        return openMembersPaneImpl()
      } catch (error) {
        reportDiag({ event: 'open-members-failed', build: BUILD_STAMP, error: String(error?.message ?? error) })
        return false
      }
    }

    /** Resolve the current session id from props, then from the page URL. */
    function resolveSessionId(props) {
      const fromProps = props?.sessionId ?? props?.session?.id ?? props?.useChat?.()?.sessionId
      if (typeof fromProps === 'string' && fromProps !== '') return fromProps
      try {
        const text = `${globalThis.location?.hash ?? ''} ${globalThis.location?.pathname ?? ''}`
        const match = /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(text)
        if (match) return match[0]
      } catch {
        // A missing location (offline tests) falls through to 'unknown'.
      }
      return 'unknown'
    }

    /** In-memory mirror of the toggle, plus the durable browser copy. */
    const flags = new Map()
    const STORE_PREFIX = 'dsh-team:team:'

    function readFlag(sessionId) {
      if (flags.has(sessionId)) return flags.get(sessionId)
      try {
        return globalThis.localStorage?.getItem(STORE_PREFIX + sessionId) === '1'
      } catch {
        return false
      }
    }

    function writeFlag(sessionId, value) {
      flags.set(sessionId, value)
      try {
        globalThis.localStorage?.setItem(STORE_PREFIX + sessionId, value ? '1' : '0')
      } catch {
        // Private mode or a blocked storage must not break the toggle.
      }
    }

    /**
     * 「团队协作」开关：一个方框 + 一条缎带。
     * 方框是真 checkbox（点整条都能切，键盘空格也行）；缎带是薄荷底英文前缀、琥珀底中文、
     * 橙红两格收尾。关着的时候缎带去色压暗，方框空着。
     */
    function TeamToggle(props) {
      const [on, toggle] = useTeamFlag(props)
      const ribbon = (background, color, text, extra) => h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            height: '100%',
            padding: '0 7px',
            background,
            color,
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: '0.06em',
            whiteSpace: 'nowrap',
            ...extra,
          },
        },
        text,
      )
      return h(
        'label',
        {
          title: on ? '团队协作：开（可以派活给团队成员）' : '团队协作：关（team_dispatch 会从工具表消失）',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 24,
            padding: '0 6px',
            border: '1px solid rgba(0,0,0,0.16)',
            borderRadius: 2,
            background: 'rgba(255,255,255,0.35)',
            cursor: 'pointer',
            userSelect: 'none',
            boxSizing: 'border-box',
          },
        },
        h(
          'span',
          {
            style: {
              display: 'inline-flex',
              alignItems: 'stretch',
              height: 18,
              overflow: 'hidden',
              opacity: on ? 1 : 0.5,
              filter: on ? 'none' : 'grayscale(0.85)',
              transition: 'opacity 120ms ease, filter 120ms ease',
            },
          },
          ribbon('#8FD9A8', '#ffffff', 'TEAM'),
          ribbon('#F2C43C', '#1F1E18', '团队协作', { fontSize: 11.5 }),
          h('span', { 'aria-hidden': true, style: { width: 6, background: '#F0872F' } }),
          h('span', { 'aria-hidden': true, style: { width: 6, background: '#E23B2E' } }),
        ),
        // 勾选框放在缎带右边。
        h('input', {
          type: 'checkbox',
          checked: on,
          onChange: toggle,
          style: {
            width: 15,
            height: 15,
            margin: 0,
            flex: '0 0 auto',
            accentColor: '#F2C43C',
            cursor: 'pointer',
          },
        }),
      )
    }

/**
 * 成员面板（第一版）。
 *
 * 把「小队成员」挂成右侧栏的一个 tab，注册分两步，两步都用同一个 id：
 *  1. 类型（静态声明）——`ctx.sidebarRightTabs.register({ id, kind, title, ... })`；
 *  2. 正文（React 组件）——`ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, Panel)`。
 * 打开该 tab 走导航控制器：`ctx.sidebarRight.openTab(MEMBERS_TAB_KIND)`（页面类型按 kind
 * 打开，不认资源地址）；definition.guide 同时让它在右栏引导页里有一张入口卡片。
 *
 * 数据：现在全部来自下面的 DEMO_MEMBERS，写死只是为了先把界面摆出来。等 Host 半区能
 * 给出真实成员列表后，把数据换成插槽 `inject` 下发的 props 即可——Panel 已经优先读
 * `props.members`（数组），没有就退回 DEMO_MEMBERS，其余代码不用动。
 */

/** 本实现在 tab 系统里的唯一身份；正文槽位、标题槽位都以它为 key（第二个注册的 id 会 throw）。 */
const MEMBERS_TAB_ID = 'dsh-team/members'

/** 每次改客户端都改这个戳，用来判断页面拿到的是不是新 bundle。 */
const BUILD_STAMP = 'a15'

/**
 * 把「子会话 → Bot」的映射发布给 dsh-avatar-frame：
 * localStorage 一个键 + 一个自定义事件。对方没装就只是写了个没人看的键。
 */
const TEAM_IDENTITY_KEY = 'dsh-team:identity/v1'
const TEAM_IDENTITY_EVENT = 'dsh-team:identity'

/**
 * 启动自检：这个客户端半区依赖哪些 DSH 服务。
 * 缺哪个就记下来，面板顶上直接写明，不再静默失效。
 */
const SELF_CHECK = { missing: [], checked: false }

/** 服务可达性只报一次。 */
let servicesReported = false

/** 头像插件请求打开某个 Bot 的设置时，先把 id 放这里，面板挂载后取走。 */
let pendingEditorBot = null

/** 上次写出去的字符串，避免每 10 秒都触发重渲染。 */
let lastIdentityRaw = null

/**
 * 拉一次名册并把映射写给头像插件。
 * @param force - true 时忽略缓存，立即重写。
 */
async function publishTeamIdentity(force = false) {
  try {
    // 账本全量：每个子会话都能对上 Bot（不只每个 Bot 的最近一次）。
    const response = await fetch('/dsh-team/identity-map')
    const data = await response.json()
    const map = data?.map ?? {}
    const raw = JSON.stringify(map)
    if (!force && raw === lastIdentityRaw) return
    lastIdentityRaw = raw
    localStorage.setItem(TEAM_IDENTITY_KEY, raw)
    window.dispatchEvent(new CustomEvent(TEAM_IDENTITY_EVENT))
  } catch {
    // 主进程没起来或者名册读不到：保持上一次的映射。
  }
}

/**
 * 立刻把一条「子会话 → Bot 身份」写进映射，不等 10 秒轮询。
 *
 * 头像插件在会话标签挂上去的那一刻就会读这份映射；等下一轮轮询，前几秒
 * 子会话会顶着主会话的头像和 ID。开页之前先写，第一帧就是对的。
 *
 * @param sessionId - 子会话号。
 * @param identity - 宿主给的整条身份记录（id / name / src / onOpen / speech）。
 */
function stampTeamIdentity(sessionId, identity) {
  if (!sessionId || !identity || typeof identity !== 'object') return
  try {
    const raw = localStorage.getItem(TEAM_IDENTITY_KEY)
    const map = raw ? JSON.parse(raw) : {}
    map[String(sessionId)] = identity
    const next = JSON.stringify(map)
    lastIdentityRaw = next
    localStorage.setItem(TEAM_IDENTITY_KEY, next)
    window.dispatchEvent(new CustomEvent(TEAM_IDENTITY_EVENT))
  } catch {
    // 写不进去就靠 10 秒轮询兜底
  }
}

/** tab 类型判别值；`ctx.sidebarRight.openTab` 用它开页。 */
const MEMBERS_TAB_KIND = 'dsh-team-members'

/** 右栏 tab 正文的槽位名（keyed，scope 为 session）。 */
const MEMBERS_SLOT = 'sidebar.right.pane.tab'

/**
 * 演示用成员表。字段：
 *  - id     成员名，头像取它的首字
 *  - role   职责
 *  - status busy | idle | offline，决定分组与状态色
 *  - tasks  手上几件活
 * 真实数据接上后，这个常量只留作空数据时的兜底或直接删掉。
 */
const DEMO_MEMBERS = [
  { id: 'nova', role: '研究员', status: 'busy', tasks: 1 },
  { id: 'forge', role: '审图', status: 'idle', tasks: 0 },
  { id: 'echo', role: '写作', status: 'offline', tasks: 0 },
]

/** 分组顺序：先忙、再空闲、最后离线。 */
const STATUS_ORDER = ['standby', 'busy', 'idle', 'offline', 'disabled']

const STATUS_META = {
  standby: {
    label: '待命',
    get color() {
      return palette().accentSoft ?? palette().accent
    },
  },
  busy: {
    label: '忙',
    get color() {
      return palette().warn
    },
  },
  idle: {
    label: '空闲',
    get color() {
      return palette().good
    },
  },
  offline: {
    label: '离线',
    get color() {
      return palette().faint
    },
  },
  disabled: {
    label: '停用',
    get color() {
      return palette().faint
    },
  },
}

/** 只用 --dsw-alias-* 设计令牌，后面跟回退值；不写死主题色。 */
const COLOR = {
  get text() {
    return palette().text
  },
  get secondary() {
    return palette().dim
  },
  get tertiary() {
    return palette().faint
  },
  get border() {
    return palette().line
  },
  get surface() {
    return palette().surface
  },
  get avatar() {
    return palette().raised
  },
  get accent() {
    return palette().accent
  },
  get accentSoft() {
    return palette().accentSoft
  },
}

/** 成员卡高度，长方形卡片。 */
const CARD_HEIGHT = 68

/** 用户在任务里留的反馈口径（和 team_user_feedback 的 signal 对应）。 */
const USER_SIGNAL_LABELS = { praise: '说不错', fix: '要改', miss: '漏了东西', repeat: '老毛病又犯' }

/**
 * 造出成员面板：正文组件 + 注册函数。
 * @param React - React 实现（由加载器传入，便于离屏测试）。
 * @returns `{ register(ctx), Panel }`。
 */
function createMembersPanel(React, host) {
  if (typeof React?.createElement !== 'function') {
    throw new Error('createMembersPanel: 需要传入 React（缺少 createElement）')
  }
  const h = React.createElement

  /**
   * 真正打开成员页：ctx 在这里（参数 host），所以能取到 sidebarRight。
   * 之前这段写在工厂作用域，那里没有 ctx，取服务必然拿不到。
   */
  function installOpenMembersPane() {
    openMembersPaneImpl = () => {
      const service = (name) => {
        try {
          if (typeof host?.get === 'function') {
            const found = host.get(name)
            if (found !== undefined) return found
          }
        } catch {
          // 落到属性访问
        }
        try {
          return host?.[name]
        } catch {
          return undefined
        }
      }

      // 右栏已经开着、而且正显示成员列表：不再重复打开（重复打开会把布局搞乱）。
      // 右栏已经开着、而且成员列表真的看得见：不再重复打开（重复打开会把布局搞乱）。
      // 注意要判「可见」而不是「在 DOM 里」——手收右栏之后节点可能还在，只是隐藏了。
      const membersPaneVisible = () => {
        try {
          const element = globalThis.document?.querySelector('[data-dsh-team-members]')
          if (!element) return false
          const rect = element.getBoundingClientRect?.()
          if (!rect || rect.width === 0 || rect.height === 0) return false
          const style = globalThis.getComputedStyle?.(element)
          if (style && (style.display === 'none' || style.visibility === 'hidden')) return false
          return true
        } catch {
          return false
        }
      }
      if (membersPaneVisible()) {
        reportDiag({ event: 'open-members', build: BUILD_STAMP, skipped: 'already-showing' })
        return true
      }

      const sidebar = service('sidebarRight')
      let switched = false
      if (sidebar && typeof sidebar.openTab === 'function') {
        // openTab 既切页也把右栏展开；不要再调 layout.openRightbar（它只上报呈现）。
        try {
          sidebar.openTab(MEMBERS_TAB_KIND, { params: {} })
          switched = true
        } catch (error) {
          reportDiag({ event: 'open-members-failed', where: 'openTab', error: String(error?.message ?? error) })
        }
      } else {
        reportDiag({ event: 'open-members-failed', where: 'no-sidebarRight', build: BUILD_STAMP })
        // 降级：不静默——告诉用户为什么打不开，而不是点了没反应。
        try {
          onMembersPaneFailed?.('拿不到右栏接口，成员面板打不开；多半是 DSH 版本不匹配（见面板顶部的自检提示）。')
        } catch {
          // 面板没挂上也不影响别的
        }
      }
      reportDiag({ event: 'open-members', build: BUILD_STAMP, sidebar: Boolean(sidebar), switched })
      return switched
    }
  }

  /** 五角星（照参考图：纯黄，无描边）。 */
  function StarShape({ size = 11, filled = true }) {
    return h(
      'svg',
      {
        'aria-hidden': true,
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        style: { display: 'block', filter: 'drop-shadow(0 1px 1.6px rgba(0,0,0,0.45))' },
      },
      h('path', {
        d: 'M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.3 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z',
        fill: filled ? '#FFD21E' : 'rgba(0,0,0,0.12)',
      }),
    )
  }

  /** 显示 1–6 星：每颗单独转角，前一颗的尖角落进后一颗的空档里。 */
  function StarsRow({ count = 0, size = 11 }) {
    if (!Number.isFinite(count) || count <= 0) return null
    const total = Math.min(6, Math.round(count))
    return h(
      'span',
      { style: { display: 'inline-flex', alignItems: 'center', flex: '0 0 auto' } },
      Array.from({ length: total }, (_, index) => h(
        'span',
        {
          key: index,
          style: {
            display: 'block',
            // 负边距让角咬进下一颗的空档；转角统一但错开一点点，避免看起来像一条直线。
            marginLeft: index === 0 ? 0 : -Math.round(size * 0.34),
            // 顺时针倾斜（朝右歪）。
            transform: `rotate(${16 + (index % 2) * 4}deg)`,
          },
        },
        h(StarShape, { size }),
      )),
    )
  }
  /** 可点击的星级选择：再点同一颗就清零。 */
  function StarPicker({ value = 0, onChange, max = 6 }) {
    const limit = Math.max(1, Math.min(6, Number(max) || 6))
    return h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 2 } },
      Array.from({ length: limit }, (_, index) => {
        const count = index + 1
        return h(
          'button',
          {
            key: count,
            type: 'button',
            'aria-label': `${count} 星`,
            onClick: () => onChange?.(value === count ? 0 : count),
            style: { padding: 0, background: 'transparent', border: 'none', cursor: 'pointer', lineHeight: 1 },
          },
          h(StarShape, { size: 16, filled: count <= value }),
        )
      }),
    )
  }

  /** 卡片上的 token 徽章：真实用量 + 老记录的折算量；有折算时前面加「≈」。 */
  function tokenBadge(real, estimated, partial) {
    const sum = (Number(real) || 0) + (Number(estimated) || 0)
    return `${partial ? '≈' : ''}${formatTokens(sum)}`
  }

  /** 老记账本没有 token，只能按字数折算，悬停时说明一句。 */
  function tokenTitle(base, partial) {
    return partial ? `${base}（含老记录按字数折算）` : base
  }

  // 徽章的呼吸和流光：横幅只有一条 style，注入一次，重复渲染不会叠加。
  let globalSheet = null
  function ensureGlobalSheet() {
    if (globalSheet || typeof document === "undefined") return
    const tag = document.createElement("style")
    tag.dataset.dshTeam = "promote-badge"
    tag.textContent = `
@keyframes dshTeamBadgePulse {
  /* 只让光晕变，文字和位置完全不动 */
  0%, 100% { box-shadow: 0 1px 2px rgba(0,0,0,0.25); }
  50% { box-shadow: 0 1px 6px rgba(255,122,47,0.55); }
}
@keyframes dshTeamBadgeShine {
  0% { background-position: 180% 0, 0 0; }
  100% { background-position: -80% 0, 0 0; }
}
/* 晋升：外圈匀速转，中间的十字和底下的三色块呼吸。 */
@keyframes dshTeamPromoteSpin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@keyframes dshTeamPromoteBreathe {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}
`
    document.head.appendChild(tag)
    globalSheet = tag
  }

  /** 三个段位的名字。 */
  function rankLabel(rank) {
    return ['普通', '精英化一阶', '精英化二阶'][Number(rank) || 0] ?? '普通'
  }

  /**
   * 段位配色：普通黑字；精英化一阶金色带阴影；精英化二阶彩色渐变带阴影。
   * @param rank - 0/1/2。
   * @param p - 当前调色板。
   */
  function rankStyle(rank, p) {
    const level = Number(rank) || 0
    // 深色横条：左侧三色细条，右上角一个小方点——和分组标题同一套语言。
    const plate = {
      display: 'inline-flex',
      alignItems: 'center',
      height: 15,
      padding: '0 4px 0 8px',
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: '0.04em',
      borderRadius: 0,
      whiteSpace: 'nowrap',
      color: '#F2F2F2',
      backgroundImage: 'linear-gradient(to right, #86C1AF 0 2px, #EBA93F 2px 4px, #992C27 4px 6px)',
      backgroundColor: '#313131',
      backgroundRepeat: 'no-repeat',
      boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
    }
    if (level >= 2) return { ...plate, color: '#FFF6D6' }
    if (level === 1) return { ...plate, color: '#FFF6D6' }
    return { display: 'inline-flex', alignItems: 'center', padding: 0, color: p.text }
  }

  /** 段位横条右侧的小方点：二阶橙红、一阶金黄。 */
  function rankDotColor(rank) {
    return Number(rank) >= 2 ? '#FF6B3D' : '#FFC93C'
  }



  /** 0.42 -> "42%"；null 显示破折号。 */
  function percent(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '—'
    return `${Math.round(Number(value) * 100)}%`
  }

  function formatTokens(value) {
    const n = Math.max(0, Number(value) || 0)
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
    return String(n)
  }

  /** 秒数 -> "42s" / "3m12s" / "1h04m"。 */
  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0))
    if (total < 60) return `${total}s`
    const minutes = Math.floor(total / 60)
    if (minutes < 60) return total % 60 === 0 ? `${minutes}m` : `${minutes}m${total % 60}s`
    return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
  }

  function statusOf(key) {
    return STATUS_META[key] ?? { label: key ? String(key) : '—', color: COLOR.tertiary }
  }

  /** 按状态分组：已知状态按 STATUS_ORDER 排，未知状态并进「其他」。 */
  /**
   * 成员分组：行动组（这个会话能用的）、用户自建的组、行动预备组（兜底）。
   * @param members - 名册成员，带 inTeam 与 group。
   * @param userGroups - 自建组列表。
   */
  function buildGroupList(members, userGroups) {
    const list = Array.isArray(userGroups) ? userGroups : []
    const known = new Set(list.map((group) => group.id))
    const action = sortGroupItems(members.filter((member) => member?.inTeam !== false))
    const rest = members.filter((member) => member?.inTeam === false)
    const custom = list.map((group) => ({
      key: 'g:' + group.id,
      id: group.id,
      meta: { label: group.name },
      items: sortGroupItems(rest.filter((member) => member?.group === group.id)),
    }))
    const reserve = sortGroupItems(rest.filter((member) => !known.has(member?.group)))
    return [
      { key: 'action', meta: { label: '行动组' }, items: action },
      ...custom,
      { key: 'reserve', meta: { label: '行动预备组' }, items: reserve },
    ]
  }

  /**
   * 同组内的排序：星级高的在前；同星看等级；同星同级看谁先到这个等级。
   * @param items - 组内成员。
   */
  function sortGroupItems(items) {
    return [...items].sort((a, b) => {
      const starsA = Number(a?.stars) || 0
      const starsB = Number(b?.stars) || 0
      if (starsA !== starsB) return starsB - starsA
      const lvA = Number(a?.lv) || 0
      const lvB = Number(b?.lv) || 0
      if (lvA !== lvB) return lvB - lvA
      const sinceA = Number(a?.levelSince) || 0
      const sinceB = Number(b?.levelSince) || 0
      return sinceA - sinceB
    })
  }

  function groupMembers(members) {
    const buckets = new Map(STATUS_ORDER.map((key) => [key, []]))
    const other = []
    for (const member of members) {
      const status = member?.enabled === false ? 'disabled' : member?.status
      const bucket = buckets.get(status)
      if (bucket === undefined) other.push(member)
      else bucket.push(member)
    }
    const groups = STATUS_ORDER
      .filter((key) => buckets.get(key).length > 0)
      .map((key) => ({ key, meta: STATUS_META[key], items: buckets.get(key) }))
    if (other.length > 0) {
      groups.push({ key: 'other', meta: { label: '其他', color: COLOR.tertiary }, items: other })
    }
    return groups
  }

  /**
   * 面板右上角的按钮：默认只有一个符号；带文字时变成「图标 + 文字」的小胶囊。
   * @param props - `{ label, glyph, icon, text, action, onActivate }`。
   */
  function HeaderButton({ label, glyph, icon, text, action, onActivate }) {
    const hasText = typeof text === 'string' && text !== ''
    return h(
      'button',
      {
        type: 'button',
        'aria-label': label,
        title: label,
        onClick: () => {
          if (typeof onActivate === 'function') {
            onActivate()
            return
          }
          console.log(`[dsh-team] 成员面板：${action}（占位，尚未实现）`)
        },
        style: {
          height: 24,
          width: hasText ? undefined : 24,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          padding: hasText ? '0 7px' : 0,
          border: 'none',
          borderRadius: 6,
          background: 'transparent',
          color: COLOR.secondary,
          fontSize: hasText ? 11 : 14,
          lineHeight: 1,
          whiteSpace: 'nowrap',
          cursor: 'pointer',
        },
      },
      icon ?? glyph,
      hasText ? text : null,
    )
  }

  /** 一张长方形成员卡：左圆头像，右侧名字+职责 / 状态+手上 N 件。 */
  /** 一张成员卡：经典是圆头像圆角卡；孤星是直角、细线、左侧橙条。 */
  /** 小数据库图标：标注 token 消耗，和 DSH 原生计数一个样式。 */
  function TokenIcon({ size = 11 }) {
    return h(
      'svg',
      {
        'aria-hidden': true,
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        style: { display: 'block', flex: '0 0 auto', opacity: 0.75 },
      },
      h('ellipse', { cx: 12, cy: 5.5, rx: 7, ry: 2.6 }),
      h('path', { d: 'M5 5.5v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6v-6' }),
      h('path', { d: 'M5 11.5v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6v-6' }),
    )
  }

  /** 橙色的扳手：打开成员设置。 */
  function WrenchIcon({ size = 16 }) {
    return h(
      'svg',
      {
        'aria-hidden': true,
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        style: { display: 'block' },
      },
      h('path', {
        d: 'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.2.2.5.3.7.3.2 0 .5-.1.7-.3l2.3-2.3c.5-.4.5-1.1.1-1.4z',
        fill: '#E77547',
      }),
    )
  }

  /**
   * 橙色锤子：新增成员组的入口。
   * 两根 45° 的粗杠——上面一根长的当锤头，左下短的一根当柄，中间留一道缝。
   */
  function HammerIcon({ size = 13, color = '#F2672E' }) {
    return h(
      'svg',
      {
        'aria-hidden': true,
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: color,
        style: { display: 'block', flex: '0 0 auto' },
      },
      h('rect', { x: 7.5, y: 2.5, width: 14, height: 7.5, rx: 0.8, transform: 'rotate(45 14.5 6.25)' }),
      h('rect', { x: 3.5, y: 12, width: 10, height: 5.5, rx: 0.8, transform: 'rotate(-45 8.5 14.75)' }),
    )
  }

  /**
   * 笔：编辑团队知识库。和锤子同一套画法（24 网格、实心、同色）。
   * @param props - `{ size, color }`。
   */
  function PenIcon({ size = 13, color = '#F2672E' }) {
    return h(
      'svg',
      {
        'aria-hidden': true,
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: color,
        style: { display: 'block', flex: '0 0 auto' },
      },
      h('path', { d: 'M3 17.25 V21 h3.75 L17.8 9.94 l-3.75 -3.75 z' }),
      h('path', { d: 'M20.7 7.04 a1 1 0 0 0 0 -1.41 l-2.34 -2.34 a1 1 0 0 0 -1.41 0 l-1.83 1.83 3.75 3.75 z' }),
    )
  }

  /** 成长档案入口用的小图标：三根柱子。 */
  /**
   * 橙色叉：彻底删掉这个成员。和锤子、柱状图同一套画法（24 网格、粗笔画）。
   */
  function CloseIcon({ size = 16, color = '#E77547' }) {
    return h(
      'svg',
      { 'aria-hidden': true, width: size, height: size, viewBox: '0 0 24 24', style: { display: 'block' } },
      h('g', { stroke: color, strokeWidth: 3.4, strokeLinecap: 'round' },
        h('path', { d: 'M6 6 L18 18' }),
        h('path', { d: 'M18 6 L6 18' }),
      ),
    )
  }

  function ChartIcon({ size = 15 }) {
    return h(
      'svg',
      { 'aria-hidden': true, width: size, height: size, viewBox: '0 0 24 24', style: { display: 'block' } },
      h('g', { fill: '#86C1AF' },
        h('rect', { x: 3, y: 13, width: 4.5, height: 7 }),
        h('rect', { x: 9.75, y: 8, width: 4.5, height: 12 }),
        h('rect', { x: 16.5, y: 3, width: 4.5, height: 17 }),
      ),
    )
  }

  function MailEnvelope({ count = 0, onClick }) {
    const [node, setNode] = React.useState(null)
    const [previous, setPrevious] = React.useState(count)
    const [lastShake, setLastShake] = React.useState(0)
    const unread = count > 0
    const shake = () => {
      if (!node || typeof node.animate !== 'function') return
      if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return
      const now = Date.now()
      if (now - lastShake < 10000) return
      setLastShake(now)
      node.animate(
        [
          { transform: 'rotate(0deg)' },
          { transform: 'rotate(-5deg)' },
          { transform: 'rotate(5deg)' },
          { transform: 'rotate(-3deg)' },
          { transform: 'rotate(0deg)' },
        ],
        { duration: 700, easing: 'ease-in-out' },
      )
    }
    React.useEffect(() => {
      if (!node) return
      if (count > previous) shake()
      if (count !== previous) setPrevious(count)
    }, [count, node, previous])
    const color = unread ? '#E77547' : '#B7BB60'
    return h(
      'button',
      {
        ref: setNode,
        type: 'button',
        title: unread ? `${count} 条未读消息` : '没有未读消息',
        'aria-label': unread ? `${count} 条未读消息` : '没有未读消息',
        onClick: (event) => {
          event.stopPropagation()
          onClick?.()
        },
        onMouseEnter: shake,
        style: {
          flex: '0 0 auto',
          width: 16,
          height: 18,
          margin: '0 -2px',
          padding: 0,
          border: 0,
          background: 'transparent',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          opacity: unread ? 1 : 0.9,
          color,
          transformOrigin: '50% 50%',
        },
      },
      h(
        'svg',
        { width: 12, height: 9.5, viewBox: '0 0 14 11', 'aria-hidden': true, style: { display: 'block' } },
        h('rect', {
          x: 0.7,
          y: 0.7,
          width: 12.6,
          height: 9.6,
          rx: 1.4,
          fill: 'currentColor',
          stroke: 'none',
        }),
        h('path', {
          d: 'M1.4 2.2 L7 6.3 L12.6 2.2',
          fill: 'none',
          stroke: '#FFFDF7',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      ),
    )
  }

  function TaskMailThread({ taskId, p }) {
    const [messages, setMessages] = React.useState([])
    React.useEffect(() => {
      let alive = true
      fetch(`/dsh-team/mailbox?taskId=${encodeURIComponent(taskId)}&limit=50`)
        .then((response) => response.json())
        .then((payload) => {
          if (alive && payload.ok) setMessages(payload.messages ?? [])
        })
        .catch(() => {})
      return () => {
        alive = false
      }
    }, [taskId])
    if (messages.length === 0) return null
    return h(
      'div',
      { style: { marginTop: 10, paddingTop: 8, borderTop: `1px solid ${p.line}` } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: p.dim } },
        h(MailEnvelope, { count: 0, onClick: () => {} }),
        `消息 ${messages.length}`,
      ),
      messages.map((message) => h(
        'div',
        { key: message.id, style: { marginTop: 8, fontSize: 11, lineHeight: 1.6 } },
        h('div', { style: { color: p.faint } }, `${message.from} → ${message.to}${message.subject ? ` · ${message.subject}` : ''}`),
        h('div', { style: { whiteSpace: 'pre-wrap', color: p.text } }, message.body),
      )),
    )
  }

  function MailboxDialog({ bot, p, onClose }) {
    const [data, setData] = React.useState({ messages: [], unread: 0 })
    const [error, setError] = React.useState('')
    React.useEffect(() => {
      let alive = true
      setError('')
      fetch(`/dsh-team/mailbox?bot=${encodeURIComponent(bot?.id ?? '')}&limit=20`)
        .then((response) => response.json())
        .then((payload) => {
          if (!alive) return
          if (payload.error) throw new Error(payload.error)
          setData({ messages: payload.messages ?? [], unread: Number(payload.unread ?? 0) })
        })
        .catch((err) => {
          if (alive) setError(String(err?.message ?? err))
        })
      return () => {
        alive = false
      }
    }, [bot?.id])
    const shown = data.messages.slice(0, 3)
    return h(
      'div',
      {
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 1000,
          background: 'rgba(20,24,22,0.35)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        },
        onClick: onClose,
      },
      h(
        'div',
        {
          onClick: (event) => event.stopPropagation(),
          style: {
            width: 520,
            maxWidth: '100%',
            maxHeight: '70vh',
            overflow: 'auto',
            background: p.surface,
            border: `1px solid ${p.line}`,
            borderRadius: 8,
            boxShadow: '0 18px 50px rgba(20,24,22,0.28)',
            padding: 18,
            color: p.text,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h(MailEnvelope, { count: data.unread, onClick: () => {} }),
          h('strong', { style: { fontSize: 14 } }, `${bot?.name ?? bot?.id} 的信箱`),
          data.unread > 0 ? h('span', { style: { fontSize: 11, color: '#C45A2E' } }, `${data.unread} 条未读`) : null,
          h('button', {
            type: 'button',
            onClick: onClose,
            style: { marginLeft: 'auto', border: 0, background: 'transparent', color: p.dim, cursor: 'pointer', fontSize: 16 },
            'aria-label': '关闭',
          }, '×'),
        ),
        h('div', { style: { marginTop: 4, fontSize: 10.5, color: p.faint } }, '只读。Bot 下次开始任务时才会读到；这里的查看不算已读。'),
        error ? h('div', { style: { marginTop: 12, color: '#B44836', fontSize: 12 } }, error) : null,
        !error && shown.length === 0 ? h('div', { style: { marginTop: 18, color: p.faint, fontSize: 12 } }, '还没有消息。') : null,
        shown.map((message) => h(
          'div',
          { key: message.id, style: { marginTop: 12, paddingTop: 10, borderTop: `1px solid ${p.line}` } },
          h('div', { style: { fontSize: 11, color: p.dim } }, `${message.from} → ${message.to}${message.subject ? ` · ${message.subject}` : ''}`),
          h('div', { style: { marginTop: 4, fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap' } }, message.body),
        )),
        data.messages.length > 3 ? h('div', { style: { marginTop: 10, fontSize: 10.5, color: p.faint } }, `还有 ${data.messages.length - 3} 条，先看最近三条。`) : null,
      ),
    )
  }

  const PanelMemberCard = React.memo(function PanelMemberCard({ member, onOpen, onOpenSession, onOpenMailbox, hint, onSettings, onPromote, onArchive, onRemove }) {
    const skin = useSkin()
    const p = palette()
    const aurora = false
    // 有背景图时小字加深，否则压在图上会发灰
    const dimColor = member?.background ? '#33332C' : p.dim
    const faintColor = member?.background ? '#45433A' : p.faint
    // 背景遮罩强度：0 = 完全不铺白，1 = 默认。
    const bgAlpha = Number.isFinite(Number(member?.backgroundOpacity)) ? Number(member.backgroundOpacity) : 1
    // 字重：整体跟着走，名字再重一点。
    const cardFontWeight = Math.min(900, Math.max(300, Number(member?.fontWeight) || 400))
    const nameFontWeight = Math.min(900, Math.max(600, cardFontWeight + 100))
    const meta = statusOf(member?.status)
    const tasks = Number.isFinite(member?.tasks) ? member.tasks : 0
    return h(
      'div',
      {
        'data-dsh-team-member': member?.id,
        role: 'button',
        tabIndex: 0,
        title: '点开设置',
        onClick: () => onOpenSession?.(member),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') onOpen?.(member)
        },
        style: {
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: CARD_HEIGHT,
          boxSizing: 'border-box',
          // 右侧留给 ⚙ 和标识，padding 收紧一点，别留空档。
          padding: aurora ? '0 6px 0 10px' : '0 6px 0 10px',
          border: `1px solid ${p.line}`,
          borderLeft: aurora ? `2px solid ${(p.tri ?? [])[0] ?? p.accent}` : `1px solid ${p.line}`,
          borderRadius: aurora ? 0 : 6,
          background: p.surface,
          position: 'relative',
          overflow: 'hidden',
          color: p.text,
          fontWeight: cardFontWeight,
          // 拖动分隔条改宽度时，把重排/重绘锁在卡片内部
          contain: 'layout paint style',
        },
      },
      member?.background
        ? h('img', {
            src: `/dsh-team/background?bot=${encodeURIComponent(member.id)}&v=${Number(member.backgroundAt) || 0}`,
            alt: '',
            draggable: false,
            decoding: 'async',
            style: {
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              pointerEvents: 'none',
              zIndex: 0,
            },
          })
        : null,
      member?.background
        ? h('div', {
            'aria-hidden': true,
            style: {
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              zIndex: 0,
              background: `linear-gradient(90deg, rgba(255,255,255,${(0.88 * bgAlpha).toFixed(3)}) 0%, rgba(255,255,255,${(0.66 * bgAlpha).toFixed(3)}) 35%, rgba(255,255,255,0) 88%, rgba(255,255,255,${(0.55 * bgAlpha).toFixed(3)}) 100%)`,
            },
          })
        : null,
      // 头像统一走接口：上传过就是图片，没上传由服务端给默认剪影。
      h('img', {
        // 版本号用来劈开浏览器缓存：默认头像的字样/样式改了就换个数字。
        src: `/dsh-team/avatar?bot=${encodeURIComponent(member.id)}&v=3`,
        alt: '',
        loading: 'lazy',
        decoding: 'async',
        draggable: false,
        style: {
          flex: '0 0 auto',
          position: 'relative',
          zIndex: 1,
          width: aurora ? 46 : 52,
          height: aurora ? 46 : 52,
          borderRadius: aurora ? 0 : '50%',
          border: aurora ? `1px solid ${p.line}` : 'none',
          objectFit: 'cover',
          background: p.raised,
        },
      }),
      h(
        'div',
        {
          style: {
            flex: '1 1 auto',
            minWidth: 0,
            position: 'relative',
            zIndex: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 } },
          h(
            'span',
            {
              style: {
                fontWeight: nameFontWeight,
                fontSize: 13,
                letterSpacing: aurora ? '0.04em' : undefined,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            },
            member?.name || member?.id,
          ),
          h(MailEnvelope, {
            count: Number(member?.unread) || 0,
            onClick: () => onOpenMailbox?.(member),
          }),
          // 「限定」自带 Bot：名字后面挂一个小标签（暖色渐变 + 落影，衬线字）。
          member?.limited
            ? h(
                'span',
                {
                  'aria-label': '限定',
                  title: '限定：插件自带的特殊 Bot',
                  style: {
                    flex: '0 0 auto',
                    // 名字那一行是 baseline 对齐，标签自己居中站，避免被基线顶歪。
                    alignSelf: 'center',
                    padding: '0 3px',
                    height: 13,
                    display: 'inline-flex',
                    alignItems: 'center',
                    fontSize: 9,
                    lineHeight: '13px',
                    fontWeight: 600,
                    letterSpacing: '0.06em',
                    color: '#4A3313',
                    // 不用描边：靠暖色渐变 + 一点落影立起来。
                    background: 'linear-gradient(#F7BC63, #EFA038)',
                    boxShadow: '0 1px 2px rgba(80, 50, 10, 0.35)',
                    borderRadius: 2,
                    // 衬线字：中文宋体那一挂，比默认黑体更有标签味。
                    fontFamily: '"Source Han Serif SC", "Songti SC", SimSun, serif',
                  },
                },
                '限定',
              )
            : null,
          h(
            'span',
            {
              style: {
                fontSize: 11,
                color: dimColor,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            },
            member?.name && member.name !== member.id ? `@${member.id} · ${member.role}` : member?.role,
          ),
          member?.note
            ? h(
                'span',
                {
                  style: {
                    fontSize: 11,
                    color: dimColor,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  },
                },
                `· ${member.note}`,
              )
            : null,
        ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
              marginTop: -1,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              fontSize: 11,
            },
          },
          (Number(member?.stars) || 0) > 0
            ? h(StarsRow, { count: Number(member.stars), size: 14 })
            : null,
          h(
            'span',
            { style: rankStyle(member?.rank, p) },
            rankLabel(member?.rank),
            Number(member?.rank) >= 1
              ? h('span', {
                  'aria-hidden': true,
                  style: {
                    width: 4,
                    height: 4,
                    marginLeft: 4,
                    display: 'inline-block',
                    background: rankDotColor(member?.rank),
                  },
                })
              : null,
          ),
          h('span', { style: { color: p.text } }, `LV.${Number(member?.lv) || 1}`),
          member?.canPromote
            ? h(
                // 用 span 而不是 button：全局按钮样式会加灰边和内边距，把徽章撑变形。
                'span',
                {
                  role: 'button',
                  tabIndex: 0,
                  title: `满足晋升条件，点击晋升${rankLabel((Number(member?.rank) || 0) + 1)}`,
                  'aria-label': '晋升',
                  onClick: (event) => {
                    event.stopPropagation()
                    onPromote?.(member)
                  },
                  style: {
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 2,
                    flex: '0 0 auto',
                    marginLeft: 2,
                    padding: '0 5px',
                    height: 14,
                    fontSize: 9,
                    fontWeight: 700,
                    lineHeight: '14px',
                    letterSpacing: '0.02em',
                    color: '#FFFFFF',
                    border: 'none',
                    outline: 'none',
                    appearance: 'none',
                    fontFamily: 'inherit',
                    backgroundImage:
                      'linear-gradient(100deg, rgba(255,255,255,0) 30%, rgba(255,255,255,0.55) 46%, rgba(255,255,255,0) 62%), linear-gradient(90deg, #86C1AF 0%, #EBA93F 38%, #FF7A2F 70%, #E32B2B 100%)',
                    backgroundSize: '260% 100%, 100% 100%',
                    backgroundRepeat: 'no-repeat',
                    animation: 'dshTeamBadgePulse 2.2s ease-in-out infinite, dshTeamBadgeShine 3.2s linear infinite',
                    backgroundColor: '#EBA93F',
                    borderRadius: 2,
                    boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
                    textShadow: '0 1px 1px rgba(0,0,0,0.25)',
                    cursor: 'pointer',
                    userSelect: 'none',
                    whiteSpace: 'nowrap',
                  },
                },
                '可晋升 ▲',
              )
            : null,
          (Number(member?.rank) || 0) >= 1
            ? h(
                'span',
                {
                  style: {
                    color: member?.goodRate === null || member?.goodRate === undefined
                      ? p.faint
                      : Number(member.goodRate) >= 0.7 ? p.text : p.warn,
                  },
                },
                `· 好评 ${percent(member?.goodRate)}`,
              )
            : null,
          // 一阶 49 → 50 要凑满 3 条教学：差几条要明说。
          Number(member?.rank) === 1
            && (Number(member?.lv) || 1) >= 49
            && (Number(member?.teaches) || 0) < 3
            ? h(
                'span',
                { style: { color: p.warn } },
                `· 差 ${3 - (Number(member?.teaches) || 0)} 条教学记录才到 50`,
              )
            : null,
          Number(member?.rank) === 1
            && (Number(member?.lv) || 1) >= 50
            && (Number(member?.teaches) || 0) >= 3
            && member?.canPromote !== true
            ? h(
                'span',
                { style: { color: p.warn } },
                member?.goodRate !== null && Number(member.goodRate) < 0.7
                  ? '· 好评不足'
                  : '· 条件未满',
              )
            : null,
        ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              minWidth: 0,
              fontSize: 11,
              color: dimColor,
            },
          },
          h('span', {
            'aria-hidden': true,
            style: {
              flex: '0 0 auto',
              width: aurora ? 5 : 7,
              height: aurora ? 5 : 7,
              borderRadius: aurora ? 0 : '50%',
              background: meta.color,
            },
          }),
          h('span', { style: { whiteSpace: 'nowrap' } }, meta.label),
          h(
            'span',
            {
              style: {
                color: faintColor,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            },
            `· 手上 ${tasks} 件`,
          ),
          h(
            'span',
            {
              title: tokenTitle('本次会话的真实 token 用量（模型每次回话报的 usage 合计）', member?.tokensSessionPartial),
              style: { display: 'inline-flex', alignItems: 'center', gap: 3, color: faintColor, whiteSpace: 'nowrap' },
            },
            '· ',
            h(TokenIcon, { size: 10 }),
            `${tokenBadge(member?.tokensSession, member?.tokensSessionEstimated, member?.tokensSessionPartial)} tok`,
          ),
          h(
            'span',
            {
              title: tokenTitle('这个 Bot 在所有会话里的真实 token 用量合计', member?.tokensTotalPartial),
              style: { display: 'inline-flex', alignItems: 'center', gap: 3, color: faintColor, whiteSpace: 'nowrap' },
            },
            h(TokenIcon, { size: 10 }),
            `总 ${tokenBadge(member?.tokensTotal, member?.tokensTotalEstimated, member?.tokensTotalPartial)} tok`,
          ),
          hint
            ? h(
                'span',
                {
                  style: {
                    color: p.warn,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  },
                },
                '· 正在开会话…',
              )
            : null,
        ),
      ),
      h(
        'div',
        {
          // 右侧这一条整体不触发卡片点击：点歪一点也只是没点到，不会误开子会话。
          onClick: (event) => event.stopPropagation(),
          onPointerDown: (event) => event.stopPropagation(),
          style: {
            flex: '0 0 auto',
            position: 'relative',
            zIndex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            justifyContent: 'center',
            alignSelf: 'stretch',
            padding: '0 2px 0 0',
          },
        },
        h(
          'button',
          {
            type: 'button',
            'aria-label': `彻底删除 ${member?.name || member?.id}`,
            title: '彻底删除',
            onClick: (event) => {
              event.stopPropagation()
              onRemove?.(member)
            },
            style: {
              // 三个按钮统一：命中区 30×30、图标 16。
              width: 26,
              height: 22,
              padding: 0,
              marginRight: -3,
              lineHeight: 1,
              background: 'transparent',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              display: 'grid',
              placeItems: 'center',
            },
          },
          h(CloseIcon, { size: 16 }),
        ),
        h(
          'button',
          {
            type: 'button',
            'aria-label': '成长档案',
            title: '成长档案',
            onClick: (event) => {
              event.stopPropagation()
              onArchive?.(member)
            },
            style: {
              width: 26,
              height: 22,
              padding: 0,
              marginRight: -3,
              lineHeight: 1,
              background: 'transparent',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              display: 'grid',
              placeItems: 'center',
            },
          },
          h(ChartIcon, { size: 16 }),
        ),
        h(
          'button',
          {
            type: 'button',
            'aria-label': '设置',
            title: '设置',
            onClick: (event) => {
              event.stopPropagation()
              onSettings?.(member)
            },
            style: {
              // 命中区 30×30，比图标大一圈，不用瞄准
              width: 26,
              height: 22,
              padding: 0,
              marginRight: -3,
              lineHeight: 1,
              background: 'transparent',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              display: 'grid',
              placeItems: 'center',
            },
          },
          h(WrenchIcon, { size: 16 }),
        ),
      ),
    )
  })

  /**
   * 头像裁剪器：选一张图，拖动 + 缩放，裁成方形。
   * 输出固定 256×256 的 PNG，所以服务器那边不用收原图。
   */
  function AvatarCropper({ botId, file, onCancel, onDone, onCrop }) {
    const skin = useSkin()
    const p = palette()
    const aurora = false
    const [source, setSource] = React.useState(null)
    const [baseScale, setBaseScale] = React.useState(1)
    const [scaleFactor, setScaleFactor] = React.useState(1)
    const [offset, setOffset] = React.useState({ x: 0, y: 0 })
    const [drag, setDrag] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState('')
    const box = 220

    // 读成 dataURL，再画到离屏 canvas 上拿自然尺寸。
    React.useEffect(() => {
      let alive = true
      const reader = new FileReader()
      reader.onload = () => {
        const img = new Image()
        img.onload = () => {
          if (!alive) return
          setSource({ img, url: String(reader.result), w: img.width, h: img.height })
          // 初始：短边刚好铺满裁剪框（cover），滑杆从这里起算 1×
          setBaseScale(Math.max(box / img.width, box / img.height))
          setScaleFactor(1)
          setOffset({ x: 0, y: 0 })
        }
        img.onerror = () => alive && setError('这张图读不出来')
        img.src = String(reader.result)
      }
      reader.onerror = () => alive && setError('文件读取失败')
      reader.readAsDataURL(file)
      return () => {
        alive = false
      }
    }, [file])

    if (error) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11, color: p.danger } },
        error,
        h('button', { type: 'button', onClick: onCancel }, '换一张'),
      )
    }

    if (!source) {
      return h('div', { style: { fontSize: 11, color: p.faint } }, '读取图片中…')
    }

    const displayScale = baseScale * scaleFactor
    const dispW = source.w * displayScale
    const dispH = source.h * displayScale

    const pointerDown = (event) => {
      event.currentTarget.setPointerCapture?.(event.pointerId)
      setDrag({ startX: event.clientX, startY: event.clientY, baseX: offset.x, baseY: offset.y })
    }
    const pointerMove = (event) => {
      if (!drag) return
      setOffset({ x: drag.baseX + (event.clientX - drag.startX), y: drag.baseY + (event.clientY - drag.startY) })
    }
    const pointerUp = () => setDrag(null)

    const confirm = async () => {
      setBusy(true)
      setError('')
      try {
        const out = 256
        const ratio = out / box
        const canvas = document.createElement('canvas')
        canvas.width = out
        canvas.height = out
        const ctx = canvas.getContext('2d')
        // 以裁剪框中心为原点，把图片按当前缩放和平移画进去。
        ctx.setTransform(
          displayScale * ratio,
          0,
          0,
          displayScale * ratio,
          out / 2 + offset.x * ratio,
          out / 2 + offset.y * ratio,
        )
        ctx.drawImage(source.img, -source.w / 2, -source.h / 2)
        const dataUrl = canvas.toDataURL('image/png')
        // 招募表单还没建 Bot，先只裁剪、不落盘。
        if (typeof onCrop === 'function') {
          onCrop(dataUrl)
          return
        }
        const response = await fetch('/dsh-team/avatar', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ bot: botId, dataUrl }),
        })
        const data = await response.json()
        if (!data.ok) {
          setError(data.error ?? '上传失败')
          return
        }
        onDone?.()
      } catch (problem) {
        setError(`上传失败：${problem?.message ?? problem}`)
      } finally {
        setBusy(false)
      }
    }

    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 8, fontSize: 11, color: p.dim } },
      h(
        'div',
        {
          onPointerDown: pointerDown,
          onPointerMove: pointerMove,
          onPointerUp: pointerUp,
          onPointerCancel: pointerUp,
          style: {
            position: 'relative',
            width: box,
            height: box,
            overflow: 'hidden',
            cursor: drag ? 'grabbing' : 'grab',
            touchAction: 'none',
            border: `1px solid ${p.line}`,
            borderRadius: aurora ? 0 : 6,
            background: aurora ? '#EFE9DA' : 'rgba(128,128,128,0.12)',
            alignSelf: 'center',
          },
        },
        h('img', {
          src: source.url,
          alt: '',
          draggable: false,
          style: {
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: dispW,
            height: dispH,
            transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
            userSelect: 'none',
            pointerEvents: 'none',
          },
        }),
        h('div', {
          'aria-hidden': true,
          style: {
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            boxShadow: 'inset 0 0 0 9999px rgba(0,0,0,0.06)',
            border: `1px dashed ${p.accent}`,
          },
        }),
      ),
      h('input', {
        type: 'range',
        min: 1,
        max: 4,
        step: 0.02,
        value: scaleFactor,
        onChange: (event) => setScaleFactor(Number(event.target.value)),
        'aria-label': '缩放',
        style: { width: box, alignSelf: 'center' },
      }),
      h(
        'div',
        { style: { display: 'flex', gap: 6, alignItems: 'center' } },
        h(
          'button',
          {
            type: 'button',
            onClick: confirm,
            disabled: busy,
            style: {
              padding: '4px 10px',
              fontSize: 12,
              color: aurora ? '#F6F1E5' : '#ffffff',
              background: p.accent,
              border: '1px solid transparent',
              borderRadius: aurora ? 2 : 5,
              cursor: busy ? 'wait' : 'pointer',
            },
          },
          busy ? '上传中…' : '用这张',
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: onCancel,
            style: {
              padding: '4px 10px',
              fontSize: 12,
              color: p.text,
              background: 'transparent',
              border: `1px solid ${p.line}`,
              borderRadius: aurora ? 2 : 5,
              cursor: 'pointer',
            },
          },
          '取消',
        ),
        error ? h('span', { style: { color: p.danger } }, error) : null,
      ),
    )
  }

  /**
   * 名册编辑：读/写 `/dsh-team/bots`。id 创建后不可改（它同时是记忆目录名）。
   * @param props - `{ onClose, onSaved }`。
   */
  /**
   * 团队设置：成员分组（只建组）、团队记忆、团队参数。
   *
   * 这里**不建成员、也不改成员**：新增成员走组里的「招募员工」，改成员用卡片上的
   * 扳手。「新增成员组」这个入口只留团队相关的东西。
   * @param props - `{ onClose, onSaved, sessionId, focusGroup }`。
   *   `focusGroup` 每加一，就把光标放到「新组名」上——面板头部的「新增成员组」
   *   靠它直达建组那一格。
   */
  function BotEditor({ onClose, onSaved, sessionId, focusGroup, group, inline, onDeleteGroup }) {
    /** 导入：导出目录的绝对路径。 */
    const [importPath, setImportPath] = React.useState('')
    const skin = useSkin()
    const p = palette()
    const aurora = false
    const builtInGroup = Boolean(inline && group && !group.id)
    const [groupName, setGroupName] = React.useState(group?.name ?? '')
    const [groupNameNote, setGroupNameNote] = React.useState('')
    const [bots, setBots] = React.useState([])
    const [groupNote, setGroupNote] = React.useState('')
    const [newGroup, setNewGroup] = React.useState('')
    /** 这个面板里刚建好的组：建完之后导出/导入就不用再等重开面板。 */
    const [createdGroup, setCreatedGroup] = React.useState(null)
    /** 保存团队记忆这类操作的进度/结果。 */
    const [status, setStatus] = React.useState('')
    const [teamSettings, setTeamSettings] = React.useState(null)
    const [settingsNote, setSettingsNote] = React.useState('')

    // 从「新增成员组」进来：滚到建组那一格并聚焦。
    React.useEffect(() => {
      if (!focusGroup) return undefined
      const timer = setTimeout(() => {
        const input = typeof document === 'undefined'
          ? null
          : document.querySelector('[data-dsh-team="new-group"]')
        if (!input) return
        input.scrollIntoView?.({ block: 'center' })
        input.focus?.()
      }, 80)
      timer?.unref?.()
      return () => clearTimeout(timer)
    }, [focusGroup])

    React.useEffect(() => {
      let alive = true
      void (async () => {
        try {
          const response = await fetch('/dsh-team/config')
          const data = await response.json()
          if (alive && data?.settings) setTeamSettings(data.settings)
        } catch {
          // 读不到就保持空，别挡住名册编辑。
        }
      })()
      return () => {
        alive = false
      }
    }, [])

    /**
     * 保存团队设置：并发、超时、预算、交付目录。
     * @param patch - 要改的字段。
     */
    const saveTeamSettings = async (patch) => {
      setSettingsNote('保存中…')
      try {
        const response = await fetch('/dsh-team/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...teamSettings, ...patch }),
        })
        const data = await response.json()
        if (!data.ok) {
          setSettingsNote(data.error ?? '保存失败')
          return
        }
        setTeamSettings(data.settings)
        setSettingsNote('已保存，下一次派活生效')
      } catch (error) {
        setSettingsNote(`保存失败：${error?.message ?? error}`)
      }
    }

    /** 改这个组的名字（只有自建组会走到这里）。 */
    const saveGroupName = async () => {
      if (!group?.id) return
      setGroupNameNote('保存中…')
      try {
        const response = await fetch('/dsh-team/groups', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'rename', id: group.id, name: groupName }),
        })
        const data = await response.json()
        if (!data.ok) {
          setGroupNameNote(data.error ?? '改名失败')
          return
        }
        setGroupNameNote('已改名')
        onSaved?.()
      } catch (error) {
        setGroupNameNote(`改名失败：${error?.message ?? error}`)
      }
    }

    const reload = React.useCallback(async () => {
      try {
        const response = await fetch('/dsh-team/bots')
        const data = await response.json()
        if (Array.isArray(data?.bots)) setBots(data.bots)
      } catch {
        setStatus('读不到名册')
      }
    }, [])

    React.useEffect(() => {
      void reload()
    }, [reload])

    React.useEffect(() => {
      let alive = true
      void (async () => {
        try {
          const [knowledge, user] = await Promise.all([
          ])
          if (alive) {
            setTeamFiles({
              knowledge: knowledge?.text ?? '',
              user: user?.text ?? '',
            })
          }
        } catch {
          // 读不到就先留空。
        }
      })()
      return () => {
        alive = false
      }
    }, [])

    /** 有没有「当前组」：从组卡片展开时是有的；新建面板要等这一屏里建成组之后。 */
    const hasGroup = Boolean(group || createdGroup)

    const button = (label, onClick, tone) => h(
      'button',
      {
        type: 'button',
        onClick,
        style: {
          padding: '4px 10px',
          fontSize: 12,
          color: tone === 'primary' ? (aurora ? '#F6F1E5' : '#ffffff') : p.text,
          background: tone === 'primary' ? (aurora ? p.accent : 'var(--dsw-alias-accent, #4a9eff)') : 'transparent',
          border: `1px solid ${tone === 'primary' ? 'transparent' : p.line}`,
          borderRadius: aurora ? 2 : 5,
          cursor: 'pointer',
        },
      },
      label,
    )

    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowY: 'auto' } },
      // 行内展开（组卡片下面）不带标题行：收起靠再点一次锤子。
      inline
        ? null
        : h(
            'div',
            { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            h('span', { style: { fontSize: 11, color: p.faint } }, `团队设置 · 名册 ${bots.length}`),
            h('span', { style: { marginLeft: 'auto' } }),
            button('关闭', onClose),
          ),
      group
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            builtInGroup
              ? h(
                  'div',
                  { style: { fontSize: 10, color: p.faint, lineHeight: '16px' } },
                  '内置组，不能改名或删除——成员按会话自动分进来。',
                )
              : h(
                  'div',
                  { style: { display: 'flex', gap: 4, alignItems: 'center' } },
                  h('input', {
                    value: groupName,
                    placeholder: '组名',
                    onChange: (event) => setGroupName(event.target.value),
                    style: {
                      flex: '1 1 0',
                      minWidth: 0,
                      padding: '3px 6px',
                      fontSize: 11,
                      color: p.text,
                      background: aurora ? '#FBF7EC' : 'transparent',
                      border: `1px solid ${p.line}`,
                      borderRadius: aurora ? 2 : 4,
                    },
                  }),
                  button('保存名字', saveGroupName, 'primary'),
                  button('删除这个组', () => onDeleteGroup?.(group)),
                ),
            groupNameNote !== '' ? h('div', { style: { fontSize: 10, color: p.faint } }, groupNameNote) : null,
          )
        : null,
      // 建组只在「新增成员组」入口给；从组卡片展开时这一块不出（那里只改当前组）。
      group
        ? null
        : h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('div', { style: { fontSize: 11, color: p.faint } }, '成员分组（行动组和行动预备组是内置的）'),
            h(
              'div',
              { style: { display: 'flex', gap: 4, alignItems: 'center' } },
              h('input', {
                'data-dsh-team': 'new-group',
                value: newGroup,
                placeholder: '新组名',
                onChange: (event) => setNewGroup(event.target.value),
                style: {
                  flex: '1 1 0',
                  minWidth: 0,
                  padding: '3px 6px',
                  fontSize: 11,
                  color: p.text,
                  background: aurora ? '#FBF7EC' : 'transparent',
                  border: `1px solid ${p.line}`,
                  borderRadius: aurora ? 2 : 4,
                },
              }),
              button('创建组', async () => {
                setGroupNote('创建中…')
                try {
                  const response = await fetch('/dsh-team/groups', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ action: 'create', name: newGroup }),
                  })
                  const data = await response.json()
                  if (!data.ok) {
                    setGroupNote(data.error ?? '创建失败')
                    return
                  }
                  setNewGroup('')
                  setCreatedGroup(data.group ?? true)
                  setGroupNote(`已创建：${data.group?.name ?? ''}`)
                } catch (error) {
                  setGroupNote(`创建失败：${error?.message ?? error}`)
                }
              }, 'primary'),
            ),
            groupNote ? h('div', { style: { fontSize: 10, color: p.faint } }, groupNote) : null,
          ),
      teamSettings
        ? h(
            'div',
            {
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
                borderTop: `1px solid ${p.line}`,
                paddingTop: 8,
                marginTop: 2,
              },
            },
            h('div', { style: { fontSize: 11, color: p.faint } }, '团队设置（下一次派活生效）'),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: p.faint } },
              h('button', {
                type: 'button',
                onClick: async () => {
                  // 组还没建起来时没有「当前组」，导出/导入都先拦一下。
                  if (!hasGroup) {
                    setStatus('请先创建组，再导出成员')
                    return
                  }
                  setStatus('导出中…')
                  try {
                    const response = await fetch('/dsh-team/export-pack', { method: 'POST' })
                    const data = await response.json()
                    setStatus(data?.ok
                      ? `已导出 ${data.bots} 个成员到：${data.path}`
                      : (data?.error ?? '导出失败'))
                  } catch (error) {
                    setStatus(`导出失败：${error?.message ?? error}`)
                  }
                },
                style: { padding: '2px 8px', fontSize: 10, color: p.text, background: 'transparent', border: `1px solid ${p.line}`, borderRadius: 4, cursor: 'pointer' },
              }, '导出全部成员'),
              h('span', null, '成员、人设、记忆、头像、团队知识库一起打包'),
            ),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, borderTop: `1px solid ${p.line}`, paddingTop: 6 } },
              h('div', { style: { fontSize: 10, color: p.faint } }, '导入成员（导入到当前组）'),
              // 用 label 包住隐藏的目录选择框：点文字就弹系统选择框，不用输入路径。
              h('label', {
                // 组还没建起来时没有「当前组」可导入：拦下选择框，先提示。
                onClick: (event) => {
                  if (!hasGroup) {
                    event.preventDefault()
                    setStatus('请先创建组，再导入成员')
                  }
                },
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  alignSelf: 'flex-start',
                  padding: '3px 10px',
                  fontSize: 10,
                  color: p.text,
                  background: 'transparent',
                  border: `1px solid ${p.line}`,
                  borderRadius: 4,
                  cursor: 'pointer',
                },
              },
                h('input', {
                  type: 'file',
                  // 选目录而不是单个文件（Chrome / Edge 支持）。
                  webkitdirectory: '',
                  directory: '',
                  multiple: true,
                  style: { display: 'none' },
                  onChange: async (event) => {
                    const list = Array.from(event.target.files ?? [])
                    event.target.value = ''
                    if (list.length === 0) return
                    setStatus('读取导出目录…')
                    try {
                      const files = []
                      for (const file of list) {
                        // webkitRelativePath 是「导出目录/相对路径」，只取目录内的那一段。
                        const relative = String(file.webkitRelativePath || file.name).split('/').slice(1).join('/') || file.name
                        if (!/^(bot\.json|manifest\.json|memory\/[^/]+|avatar\.(png|jpg|webp)|background\.(png|jpg|webp))$/.test(relative)) continue
                        const buffer = await file.arrayBuffer()
                        let binary = ''
                        const bytes = new Uint8Array(buffer)
                        for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
                        files.push({ path: relative, data: btoa(binary) })
                      }
                      setStatus('导入中…')
                      const response = await fetch('/dsh-team/import-bot-files', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ group: group?.id ?? '', files }),
                      })
                      const data = await response.json()
                      if (!data?.ok) { setStatus(data?.error ?? '导入失败'); return }
                      setStatus(data.renamed ? `已导入：${data.id}（同名，改了 id）` : `已导入：${data.id}`)
                      onSaved?.()
                    } catch (error) {
                      setStatus(`导入失败：${error?.message ?? error}`)
                    }
                  },
                }),
                '选择导入目录…',
              ),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              [
                // 并发 = 同一个会话里能同时跑几个子智能体（Bot）。
                ['address', '称谓（提示词里怎么称呼你）', 90, 'text'],
                ['maxConcurrent', '并发（同时跑的子智能体数）', 150, 'number'],
                // 一件活最多跑多久：从派出去开始算，到时间还没交回来就判超时、释放父会话。
                // 3600 = 1 小时，按需要自己调。
                ['taskTimeoutSec', '单任务最长运行（秒，3600 = 1 小时）', 170, 'number'],
              ].map(([key, label, width, type]) => h(
                'label',
                {
                  key,
                  style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 10, color: p.dim },
                },
                label,
                h('input', {
                  type,
                  value: teamSettings[key],
                  onChange: (event) => setTeamSettings({ ...teamSettings, [key]: event.target.value }),
                  style: {
                    width,
                    padding: '3px 5px',
                    fontSize: 11,
                    color: p.text,
                    background: aurora ? '#FBF7EC' : 'transparent',
                    border: `1px solid ${p.line}`,
                    borderRadius: aurora ? 2 : 4,
                  },
                }),
              )),
            ),
            h(
              'label',
              { style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 10, color: p.dim } },
              '交付目录（留空 = 文档目录下 dsh-team-deliverables，可填绝对路径）',
              h('input', {
                value: teamSettings.deliverableRoot ?? '',
                onChange: (event) => setTeamSettings({ ...teamSettings, deliverableRoot: event.target.value }),
                style: {
                  padding: '3px 5px',
                  fontSize: 11,
                  color: p.text,
                  background: aurora ? '#FBF7EC' : 'transparent',
                  border: `1px solid ${p.line}`,
                  borderRadius: aurora ? 2 : 4,
                },
              }),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: 6, alignItems: 'center' } },
              button('保存设置', () => saveTeamSettings({}), 'primary'),
              h('span', { style: { fontSize: 10, color: p.faint } }, settingsNote),
            ),
          )
        : null,
      // 模板 / 团队记忆 / 读名册的结果都从这一行报出去。
      status ? h('div', { style: { fontSize: 10, color: p.faint } }, status) : null,
    )
  }

  /**
   * 右栏 tab 正文。孤星模式下整块面板自带深底与细线外框——否则浅色文字会
   * 落在宿主的浅底上，标题直接看不见。
   * @param props - 插槽 props，可选 `members: Array`。
   */
  /**
   * 面板的错误边界：渲染抛错时显示原因并上报，别让整块变空白。
   */
  class PanelBoundary extends React.Component {
    constructor(props) {
      super(props)
      this.state = { error: null }
    }

    static getDerivedStateFromError(error) {
      return { error }
    }

    componentDidCatch(error, info) {
      reportDiag({
        event: 'panel-crashed',
        message: String(error?.message ?? error),
        stack: String(error?.stack ?? '').slice(0, 1200),
        info: String(info?.componentStack ?? '').slice(0, 600),
      })
    }

    render() {
      if (this.state.error) {
        return h(
          'div',
          { style: { padding: 10, fontSize: 12, color: '#c14032', lineHeight: 1.5 } },
          '成员面板出错了：',
          String(this.state.error?.message ?? this.state.error),
          h('div', { style: { marginTop: 6, opacity: 0.7 } }, '刷新可重试；原因已写进 .debug/host.log'),
        )
      }
      return this.props.children
    }
  }

  /** 面板外面套一层错误边界。 */
  function PanelSafe(props) {
    return h(PanelBoundary, null, h(Panel, props))
  }

  /** 招募表单的浅色配色，取 Rhine Lab Lumen 的浅色 token。 */
  const RECRUIT_LIGHT = {
    bg: "#F6F1E5",
    field: "#EEE9DD",
    line: "#D5CDBD",
    text: "#292923",
    muted: "#565347",
    accent: "#8B3C1C",
    onAccent: "#F4EFDF",
  }

  /**
   * 成员内联设置：点扳手后在卡片下面展开，改名字/职责/模型/能力卡/人设/头像。
   * @param props - { member, onDone }。
   */
  /**
   * 卡片背景裁切：预览框按卡片比例（5:1），拖动平移、滑杆缩放，确认后导出。
   * @param props - { file, onCancel, onConfirm }，onConfirm 收 JPEG data URL。
   */
  function BackgroundCropper({ file, onCancel, onConfirm }) {
    const boxRef = React.useRef(null)
    const bitmapRef = React.useRef(null)
    const dragRef = React.useRef(null)
    const offsetRef = React.useRef({ x: 0, y: 0 })
    const zoomRef = React.useRef(1)
    const [ready, setReady] = React.useState(false)
    const [zoom, setZoom] = React.useState(1)

    const draw = () => {
      const canvas = boxRef.current
      const bitmap = bitmapRef.current
      if (!canvas || !bitmap) return
      const ctx = canvas.getContext("2d")
      const w = canvas.width
      const h = canvas.height
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = "#F6F1E5"
      ctx.fillRect(0, 0, w, h)
      const base = Math.max(w / bitmap.width, h / bitmap.height)
      const scale = base * zoomRef.current
      const dw = bitmap.width * scale
      const dh = bitmap.height * scale
      ctx.drawImage(bitmap, (w - dw) / 2 + offsetRef.current.x, (h - dh) / 2 + offsetRef.current.y, dw, dh)
      ctx.strokeStyle = "rgba(255,255,255,0.55)"
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(w / 2, 0)
      ctx.lineTo(w / 2, h)
      ctx.stroke()
    }

    const clampOffset = (next, zoomValue = zoomRef.current) => {
      const canvas = boxRef.current
      const bitmap = bitmapRef.current
      if (!canvas || !bitmap) return next
      const w = canvas.width
      const h = canvas.height
      const base = Math.max(w / bitmap.width, h / bitmap.height)
      const scale = base * zoomValue
      const maxX = Math.max(0, (bitmap.width * scale - w) / 2)
      const maxY = Math.max(0, (bitmap.height * scale - h) / 2)
      return {
        x: Math.min(maxX, Math.max(-maxX, next.x)),
        y: Math.min(maxY, Math.max(-maxY, next.y)),
      }
    }

    React.useEffect(() => {
      let alive = true
      void (async () => {
        try {
          const bitmap = await createImageBitmap(file)
          if (!alive) return
          bitmapRef.current = bitmap
          offsetRef.current = { x: 0, y: 0 }
          zoomRef.current = 1
          setZoom(1)
          setReady(true)
          requestAnimationFrame(draw)
        } catch {
          if (alive) onCancel?.()
        }
      })()
      return () => {
        alive = false
      }
    }, [file])

    const confirm = () => {
      const bitmap = bitmapRef.current
      if (!bitmap) return
      const width = 1500
      const height = 300
      const canvas = document.createElement("canvas")
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext("2d")
      const base = Math.max(width / bitmap.width, height / bitmap.height)
      const scale = base * zoomRef.current
      const dw = bitmap.width * scale
      const dh = bitmap.height * scale
      const ratio = width / (boxRef.current?.width || width)
      ctx.fillStyle = "#F6F1E5"
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(bitmap, (width - dw) / 2 + offsetRef.current.x * ratio, (height - dh) / 2 + offsetRef.current.y * ratio, dw, dh)
      onConfirm?.(canvas.toDataURL("image/jpeg", 0.88))
    }

    return h(
      "div",
      {
        style: { position: "fixed", inset: 0, zIndex: 70, display: "grid", placeItems: "center", background: "rgba(20,22,20,0.45)" },
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onCancel?.()
        },
      },
      h(
        "div",
        {
          style: {
            width: "calc(100% - 32px)",
            maxWidth: 420,
            background: RECRUIT_LIGHT.bg,
            border: "1px solid #303332",
            padding: "10px 10px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          },
        },
        h("div", { style: { fontSize: 11, fontWeight: 700, color: RECRUIT_LIGHT.accent } }, "裁切卡片背景 · 拖动移动，滑杆缩放"),
        h(
          "div",
          {
            style: {
              position: "relative",
              width: "100%",
              aspectRatio: "5 / 1",
              background: RECRUIT_LIGHT.field,
              border: `1px solid ${RECRUIT_LIGHT.line}`,
              overflow: "hidden",
              touchAction: "none",
            },
          },
          h("canvas", {
            ref: boxRef,
            width: 1500,
            height: 300,
            style: { width: "100%", height: "100%", display: "block", cursor: "grab" },
            onPointerDown: (event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              dragRef.current = {
                startX: event.clientX,
                startY: event.clientY,
                offsetX: offsetRef.current.x,
                offsetY: offsetRef.current.y,
                // 拖动按显示宽度换算到画布像素，否则拖起来会明显偏慢
                scale: (boxRef.current?.width || 1500) / (boxRef.current?.clientWidth || 1500),
              }
            },
            onPointerMove: (event) => {
              const drag = dragRef.current
              if (!drag) return
              const next = clampOffset({
                x: drag.offsetX + (event.clientX - drag.startX) * drag.scale,
                y: drag.offsetY + (event.clientY - drag.startY) * drag.scale,
              })
              offsetRef.current = next
              draw()
            },
            onPointerUp: () => {
              dragRef.current = null
            },
            onPointerCancel: () => {
              dragRef.current = null
            },
          }),
        ),
        h(
          "label",
          { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 10, color: RECRUIT_LIGHT.muted } },
          "缩放",
          h("input", {
            type: "range",
            min: 1,
            max: 3,
            step: 0.02,
            value: zoom,
            onChange: (event) => {
              const next = Number(event.target.value)
              zoomRef.current = next
              offsetRef.current = clampOffset(offsetRef.current, next)
              setZoom(next)
              requestAnimationFrame(draw)
            },
            style: { flex: 1 },
          }),
        ),
        h(
          "div",
          { style: { display: "flex", justifyContent: "flex-end", gap: 6 } },
          h(
            "button",
            {
              type: "button",
              onClick: onCancel,
              style: {
                padding: "3px 12px",
                fontSize: 11,
                color: RECRUIT_LIGHT.muted,
                background: "transparent",
                border: `1px solid ${RECRUIT_LIGHT.line}`,
                cursor: "pointer",
              },
            },
            "取消",
          ),
          h(
            "button",
            {
              type: "button",
              onClick: confirm,
              disabled: !ready,
              style: {
                padding: "3px 14px",
                fontSize: 11,
                fontWeight: 700,
                color: RECRUIT_LIGHT.onAccent,
                background: RECRUIT_LIGHT.accent,
                border: "none",
                cursor: ready ? "pointer" : "default",
                opacity: ready ? 1 : 0.5,
              },
            },
            "用这张",
          ),
        ),
      ),
    )
  }

  function MemberSettingsInline({ member, onDone }) {
    const [form, setForm] = React.useState(null)
    const [modelGroups, setModelGroups] = React.useState([])
    const [avatarFile, setAvatarFile] = React.useState(null)
    const [avatarVersion, setAvatarVersion] = React.useState(0)
    const [bgVersion, setBgVersion] = React.useState(0)
    const [bgFile, setBgFile] = React.useState(null)
    const [note, setNote] = React.useState("")
    const [busy, setBusy] = React.useState(false)
    /** 人设只认 memory/soul.txt：只给预览 + 「编辑人设」打开文件。 */
    const [persona, setPersona] = React.useState({ text: "", path: "", note: "" })
    /** 自建组列表：成员可以挪进任何一个。 */
    const [groupList, setGroupList] = React.useState([])

    /**
     * 读回 soul.txt。
     * @param botId - 哪个 Bot；省略就用当前 member。
     */
    const loadPersona = async (botId) => {
      const id = botId ?? member.id
      try {
        const response = await fetch(`/dsh-team/persona?bot=${encodeURIComponent(id)}`)
        const data = await response.json()
        if (!data?.ok) {
          setPersona({ text: "", path: data?.path ?? "", note: data?.error ?? "读不到人设文件" })
          return
        }
        setPersona({ text: data.text ?? "", path: data.path ?? "", note: "" })
      } catch (error) {
        setPersona({ text: "", path: "", note: `读不到人设文件：${error?.message ?? error}` })
      }
    }

    /** 用系统默认程序打开 soul.txt。 */
    const openPersona = async () => {
      setPersona((current) => ({ ...current, note: "打开中…" }))
      try {
        const response = await fetch("/dsh-team/persona", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bot: member.id }),
        })
        const data = await response.json()
        if (data?.ok) {
          setPersona((current) => ({ ...current, path: data.path ?? current.path, note: "已在外部编辑器打开，改完保存，切回来会自动重读" }))
          return
        }
        setPersona((current) => ({
          ...current,
          path: data?.path ?? current.path,
          note: data?.path ? `没能自动打开，手动打开这个文件：${data.path}` : (data?.error ?? "打开失败"),
        }))
      } catch (error) {
        setPersona((current) => ({ ...current, note: `打开失败：${error?.message ?? error}` }))
      }
    }

    // 人设只在 txt 里改：面板打开时读一次；窗口重新拿到焦点（用户从记事本切回来）再读一次。
    // 所以「重新读取」不必做成按钮，切回来自己就刷新。
    React.useEffect(() => {
      const reload = () => {
        if (document.visibilityState === "hidden") return
        void loadPersona()
      }
      window.addEventListener("focus", reload)
      document.addEventListener("visibilitychange", reload)
      return () => {
        window.removeEventListener("focus", reload)
        document.removeEventListener("visibilitychange", reload)
      }
    }, [member.id])

    React.useEffect(() => {
      let alive = true
      void (async () => {
        try {
          const [bots, models, groups] = await Promise.all([
            fetch("/dsh-team/bots").then((r) => r.json()),
            fetch("/dsh-team/models").then((r) => r.json()),
            fetch("/dsh-team/groups").then((r) => r.json()).catch(() => ({})),
          ])
          if (!alive) return
          if (Array.isArray(groups?.groups)) setGroupList(groups.groups)
          const bot = (bots?.bots ?? []).find((entry) => entry.id === member.id)
          if (bot) {
            setForm({
              id: bot.id,
              name: bot.name ?? "",
              role: bot.role ?? "",
              model: bot.model ?? "",
              note: bot.note ?? "",
              group: bot.group ?? "",
              stars: Number(bot.stars) || 0,
              bgOpacity: Number.isFinite(bot.bgOpacity) ? bot.bgOpacity : 1,
              fontWeight: Number.isFinite(bot.fontWeight) ? bot.fontWeight : 400,
              agentTeam: bot.agentTeam === true,
              allow: (bot.capability?.tools?.allow ?? []).join(", "),
              deny: (bot.capability?.tools?.deny ?? []).join(", "),
            })
            void loadPersona(bot.id)
          } else {
            setNote("读不到这个 Bot 的定义")
          }
          if (Array.isArray(models?.groups)) setModelGroups(models.groups)
        } catch {
          if (alive) setNote("读取失败")
        }
      })()
      return () => {
        alive = false
      }
    }, [member.id])

    /** 裁切结果直接上传（1500×300 的 JPEG）。 */
    const uploadBackground = async (dataUrl) => {
      if (!dataUrl) return
      setNote("上传背景中…")
      try {
        const response = await fetch("/dsh-team/background", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bot: member.id, dataUrl }),
        })
        const data = await response.json()
        if (!data.ok) {
          setNote(data.error ?? "背景上传失败")
          return
        }
        setBgVersion(Date.now())
        setBgFile(null)
        setNote("背景已更新")
        window.dispatchEvent(new Event("dsh-team:changed"))
      } catch (error) {
        setNote(`背景上传失败：${error?.message ?? error}`)
      }
    }

    // 拖滑杆时先本地反馈，停 250ms 再落盘，避免每格都发一次请求。
    const bgTimer = React.useRef(null)
    const scheduleBgOpacity = (value) => {
      if (bgTimer.current) clearTimeout(bgTimer.current)
      bgTimer.current = setTimeout(async () => {
        try {
          await fetch("/dsh-team/bots", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: member.id,
              name: form.name,
              role: form.role,
              bgOpacity: value,
            }),
          })
          setBgVersion(Date.now())
          window.dispatchEvent(new Event("dsh-team:changed"))
        } catch {
          // 保存失败保持面板里的值，下次保存再试
        }
      }, 250)
    }

    // 其它滑动设置（字重等）的落盘口，和遮罩共用一套节流。
    const patchTimer = React.useRef(null)
    const scheduleBotPatch = (patch) => {
      if (patchTimer.current) clearTimeout(patchTimer.current)
      patchTimer.current = setTimeout(async () => {
        try {
          await fetch("/dsh-team/bots", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: member.id,
              name: form.name,
              role: form.role,
              ...patch,
            }),
          })
          setBgVersion(Date.now())
          window.dispatchEvent(new Event("dsh-team:changed"))
        } catch {
          // 失败保持面板里的值，下次再试
        }
      }, 250)
    }

    const clearBackground = async () => {
      try {
        await fetch(`/dsh-team/background?bot=${encodeURIComponent(member.id)}`, { method: "DELETE" })
        setBgVersion(Date.now())
        setNote("背景已清除")
        window.dispatchEvent(new Event("dsh-team:changed"))
      } catch (error) {
        setNote(`清除失败：${error?.message ?? error}`)
      }
    }

    const save = async () => {
      if (busy || !form) return
      setBusy(true)
      setNote("保存中…")
      try {
        // 改 ID 等于搬记忆目录：先改名，成功后再按新 id 存其它字段。
        let nextId = member.id
        const wantedId = String(form.id ?? "").trim().toLowerCase()
        if (wantedId !== "" && wantedId !== member.id) {
          const renamed = await fetch("/dsh-team/bots-rename", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ from: member.id, to: wantedId }),
          })
          const data = await renamed.json()
          if (!data.ok) {
            setNote(data.error ?? "改 ID 失败")
            return
          }
          nextId = data.id
        }
        const tools = {
          ...(form.allow.trim() === "" ? {} : { allow: form.allow.split(",").map((x) => x.trim()).filter(Boolean) }),
          ...(form.deny.trim() === "" ? {} : { deny: form.deny.split(",").map((x) => x.trim()).filter(Boolean) }),
        }
        const response = await fetch("/dsh-team/bots", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: nextId,
            name: form.name,
            role: form.role,
            model: form.model,
            // 空串 = 回「行动预备组」，服务端会把这个字段删掉。
            group: form.group ?? "",
            ...(form.note.trim() === "" ? {} : { note: form.note.trim() }),
            ...(form.stars > 0 ? { stars: form.stars } : {}),
            bgOpacity: form.bgOpacity,
            fontWeight: form.fontWeight,
            agentTeam: form.agentTeam === true,
            ...(Object.keys(tools).length === 0 ? {} : { capability: { tools } }),
          }),
        })
        const data = await response.json()
        if (!data.ok) {
          setNote(data.error ?? "保存失败")
          return
        }
        onDone?.()
      } catch (error) {
        setNote(`保存失败：${error?.message ?? error}`)
      } finally {
        setBusy(false)
      }
    }

    /** 停用 / 启用这个 Bot（留在名册里但不接活）。 */
    const toggleStatus = async () => {
      if (busy) return
      const next = member.enabled === false ? "active" : "disabled"
      setBusy(true)
      setNote(next === "disabled" ? "停用中…" : "启用中…")
      try {
        const response = await fetch("/dsh-team/bots-status", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: member.id, status: next }),
        })
        const data = await response.json()
        if (!data.ok) {
          setNote(data.error ?? "操作失败")
          return
        }
        onDone?.()
      } catch (error) {
        setNote(`操作失败：${error?.message ?? error}`)
      } finally {
        setBusy(false)
      }
    }

    if (!form) {
      return h(
        "div",
        { style: { padding: "8px 9px", background: RECRUIT_LIGHT.bg, fontSize: 10, color: RECRUIT_LIGHT.muted } },
        note || "读取中…",
      )
    }

    const field = (label, key, options = {}) => h(
      "label",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: 2,
          fontSize: 10,
          color: RECRUIT_LIGHT.muted,
        },
      },
      label,
      h(options.multiline ? "textarea" : "input", {
        value: form[key],
        rows: options.multiline ? 3 : undefined,
        onChange: (event) => setForm({ ...form, [key]: event.target.value }),
        style: {
          boxSizing: "border-box",
          width: "100%",
          padding: "4px 6px",
          fontSize: 11,
          fontFamily: "inherit",
          color: RECRUIT_LIGHT.text,
          background: RECRUIT_LIGHT.field,
          border: `1px solid ${RECRUIT_LIGHT.line}`,
          borderRadius: 0,
          resize: "vertical",
        },
      }),
    )

    return h(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: 4,
          padding: "8px 9px 8px",
          background: RECRUIT_LIGHT.bg,
        },
      },
      h(
        "div",
        { style: { color: RECRUIT_LIGHT.accent, fontSize: 11, fontWeight: 700, letterSpacing: "0.06em" } },
        `设置：${member.id}`
      ),
      h(
        "label",
        { style: { display: "flex", flexDirection: "column", gap: 3, fontSize: 10, color: RECRUIT_LIGHT.muted } },
        "ID（改名会连记忆目录一起搬；小写字母、数字、短横线）",
        h("input", {
          value: form.id ?? member.id,
          onChange: (event) => setForm((current) => ({ ...current, id: event.target.value })),
          style: {
            boxSizing: "border-box",
            width: "100%",
            padding: "4px 6px",
            fontSize: 11,
            fontFamily: "inherit",
            color: RECRUIT_LIGHT.text,
            background: RECRUIT_LIGHT.field,
            border: `1px solid ${RECRUIT_LIGHT.line}`,
            borderRadius: 0,
          },
        }),
      ),
      field("名字", "name"),
      field("职责", "role"),
      h(
        "label",
        { style: { display: "flex", flexDirection: "column", gap: 3, fontSize: 10, color: RECRUIT_LIGHT.muted } },
        "模型（留空跟随默认）",
        h(
          "select",
          {
            value: form.model,
            onChange: (event) => setForm({ ...form, model: event.target.value }),
            style: {
              padding: "4px 6px",
              fontSize: 11,
              color: RECRUIT_LIGHT.text,
              background: RECRUIT_LIGHT.field,
              border: `1px solid ${RECRUIT_LIGHT.line}`,
              borderRadius: 0,
            },
          },
          h("option", { value: "" }, "跟随默认"),
          modelGroups.map((group) => h(
            "optgroup",
            { key: group.provider, label: group.name },
            (group.models ?? []).map((model) => h("option", { key: model.id, value: model.id }, model.name)),
          )),
        ),
      ),
      h(
        "label",
        {
          style: { display: "flex", alignItems: "center", gap: 8, fontSize: 10, color: RECRUIT_LIGHT.muted },
        },
        "星级",
        h(StarPicker, {
          max: Number(member?.rank) >= 2 ? 6 : Number(member?.rank) === 1 ? 5 : 4,
          value: form.stars,
          onChange: (stars) => setForm({ ...form, stars }),
        }),
        h("span", { style: { color: RECRUIT_LIGHT.muted } }, form.stars > 0 ? `${form.stars} 星` : "不评"),
      ),
      // 分组：空 = 行动预备组；只有自建组可选（行动组是按会话自动分的）。
      h(
        "label",
        { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 10, color: RECRUIT_LIGHT.muted } },
        "分组",
        h(
          "select",
          {
            value: form.group ?? "",
            onChange: (event) => setForm({ ...form, group: event.target.value }),
            style: {
              flex: "1 1 0",
              minWidth: 0,
              padding: "3px 5px",
              fontSize: 10,
              color: RECRUIT_LIGHT.text,
              background: RECRUIT_LIGHT.field,
              border: `1px solid ${RECRUIT_LIGHT.line}`,
              borderRadius: 0,
            },
          },
          h("option", { value: "" }, "行动预备组（默认）"),
          groupList.map((group) => h("option", { key: group.id, value: group.id }, group.name)),
        ),
      ),
      bgFile
        ? h(BackgroundCropper, {
            file: bgFile,
            onCancel: () => setBgFile(null),
            onConfirm: (dataUrl) => uploadBackground(dataUrl),
          })
        : null,
      h(
        "div",
        { style: { display: "flex", gap: 10, alignItems: "flex-start" } },
        // 左：头像
        h(
          "div",
          { style: { flex: "0 0 auto", width: 128, display: "flex", flexDirection: "column", gap: 4 } },
          h("div", { style: { fontSize: 10, color: RECRUIT_LIGHT.muted } }, "选择头像图片"),
          avatarFile
            ? h(AvatarCropper, {
                botId: member.id,
                file: avatarFile,
                onCancel: () => setAvatarFile(null),
                onDone: () => {
                  setAvatarFile(null)
                  setAvatarVersion((v) => v + 1)
                  setNote("头像已更新")
                },
              })
            : h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: 6 } },
                h("img", {
                  src: `/dsh-team/avatar?bot=${encodeURIComponent(member.id)}&v=${avatarVersion}`,
                  alt: "",
                  style: {
                    flex: "0 0 auto",
                    width: 44,
                    height: 44,
                    objectFit: "cover",
                    background: RECRUIT_LIGHT.field,
                    border: `1px solid ${RECRUIT_LIGHT.line}`,
                  },
                }),
                h(
                  "label",
                  {
                    style: {
                      position: "relative",
                      display: "inline-flex",
                      alignItems: "center",
                      padding: "5px 10px",
                      fontSize: 11,
                      color: RECRUIT_LIGHT.onAccent,
                      background: RECRUIT_LIGHT.accent,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    },
                  },
                  "换头像",
                  h("input", {
                    type: "file",
                    accept: "image/*",
                    onChange: (event) => {
                      const file = event.target.files?.[0]
                      event.target.value = ""
                      if (file && file.type.startsWith("image/")) setAvatarFile(file)
                    },
                    style: { position: "absolute", inset: 0, opacity: 0, cursor: "pointer" },
                  }),
                ),
              ),
        ),
        // 右：缩略图 + 竖排的选图/清除 + 右侧两条滑杆
        Number(member?.rank) >= 1
          ? h(
              "div",
              { style: { flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: 4 } },
              h("div", { style: { fontSize: 10, color: RECRUIT_LIGHT.muted } }, "卡片背景（精英化一阶解锁）"),
              h(
                "div",
                // 面板窄的时候让滑杆自动换行到下一行，别被挤没
                { style: { display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" } },
                h(
                  "div",
                  { style: { flex: "0 0 auto", display: "flex", alignItems: "flex-start", gap: 6 } },
                  member.background
                    ? h("img", {
                        src: `/dsh-team/background?bot=${encodeURIComponent(member.id)}&v=${bgVersion || Number(member.backgroundAt) || 0}`,
                        alt: "",
                        style: {
                          width: 72,
                          height: 44,
                          objectFit: "cover",
                          border: `1px solid ${RECRUIT_LIGHT.line}`,
                        },
                      })
                    : h(
                        "span",
                        {
                          style: {
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 72,
                            height: 44,
                            color: RECRUIT_LIGHT.muted,
                            fontSize: 10,
                            border: `1px dashed ${RECRUIT_LIGHT.line}`,
                          },
                        },
                        "未设置",
                      ),
                  h(
                    "div",
                    { style: { display: "flex", flexDirection: "column", gap: 4 } },
                    h(
                      "label",
                      {
                        style: {
                          position: "relative",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: "4px 10px",
                          fontSize: 10,
                          color: RECRUIT_LIGHT.onAccent,
                          background: RECRUIT_LIGHT.accent,
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                        },
                      },
                      "选图",
                      h("input", {
                        type: "file",
                        accept: "image/png,image/jpeg,image/webp",
                        onChange: (event) => {
                          const picked = event.target.files?.[0]
                          event.target.value = ""
                          if (picked) setBgFile(picked)
                        },
                        style: { position: "absolute", inset: 0, opacity: 0, cursor: "pointer" },
                      }),
                    ),
                    member.background
                      ? h(
                          "button",
                          {
                            type: "button",
                            onClick: clearBackground,
                            style: {
                              padding: "2px 8px",
                              fontSize: 10,
                              color: RECRUIT_LIGHT.muted,
                              background: "transparent",
                              border: `1px solid ${RECRUIT_LIGHT.line}`,
                              cursor: "pointer",
                              whiteSpace: "nowrap",
                            },
                          },
                          "清除",
                        )
                      : null,
                  ),
                ),
                h(
                  "div",
                  { style: { flex: "1 1 auto", minWidth: 120, display: "flex", flexDirection: "column", gap: 4 } },
                  h(
                    "label",
                    { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: RECRUIT_LIGHT.muted } },
                    "遮罩",
                    h("input", {
                      type: "range",
                      min: 0,
                      max: 100,
                      step: 5,
                      value: Math.round((form.bgOpacity ?? 1) * 100),
                      onChange: (event) => {
                        const next = Number(event.target.value) / 100
                        setForm((current) => ({ ...current, bgOpacity: next }))
                        scheduleBgOpacity(next)
                      },
                      style: { flex: 1, minWidth: 0 },
                    }),
                    h("span", { style: { width: 30, textAlign: "right" } }, `${Math.round((form.bgOpacity ?? 1) * 100)}%`),
                  ),
                  h(
                    "label",
                    { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: RECRUIT_LIGHT.muted } },
                    "字重",
                    h("input", {
                      type: "range",
                      min: 300,
                      max: 900,
                      step: 50,
                      value: form.fontWeight ?? 400,
                      onChange: (event) => {
                        const next = Number(event.target.value)
                        setForm((current) => ({ ...current, fontWeight: next }))
                        scheduleBotPatch({ fontWeight: next })
                      },
                      style: { flex: 1, minWidth: 0 },
                    }),
                    h("span", { style: { width: 30, textAlign: "right" } }, String(form.fontWeight ?? 400)),
                  ),
                ),
              ),
            )
          : null,
      ),
      Number(member?.rank) >= 1
        ? null
        : h(
            "label",
            { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 10, color: RECRUIT_LIGHT.muted } },
            "字重",
            h("input", {
              type: "range",
              min: 300,
              max: 900,
              step: 50,
              value: form.fontWeight ?? 400,
              onChange: (event) => {
                const next = Number(event.target.value)
                setForm((current) => ({ ...current, fontWeight: next }))
                scheduleBotPatch({ fontWeight: next })
              },
              style: { flex: 1 },
            }),
            h("span", { style: { width: 34, textAlign: "right" } }, String(form.fontWeight ?? 400)),
          ),
      field("备注（显示在职责后面）", "note"),
      // 原生开关：让这个 Bot 用自己的子智能体；团队工具它永远拿不到（不然无限套娃）。
      h(
        "label",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 10,
            color: RECRUIT_LIGHT.muted,
            lineHeight: "15px",
            whiteSpace: "nowrap",
          },
        },
        h("input", {
          type: "checkbox",
          checked: form.agentTeam === true,
          onChange: (event) => setForm((current) => ({ ...current, agentTeam: event.target.checked })),
          style: { margin: 0, flex: "0 0 auto", accentColor: RECRUIT_LIGHT.accent },
        }),
        h("span", null, "启用智能体团队协作"),
        h(
          "span",
          { style: { color: RECRUIT_LIGHT.muted, opacity: 0.7 } },
          "允许使用DSH原生子智能体",
        ),
      ),
      field("能力卡 · 只给这些工具（逗号分隔，留空=不限制）", "allow"),
      field("能力卡 · 禁用这些工具（逗号分隔）", "deny"),
      // 人设：只有 soul.txt 一份，面板里不再摆正文，只给一行状态 + 打开文件。
      // 不要标签：「编辑人设」四个字已经把这段的意思说完了。
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 10, color: RECRUIT_LIGHT.muted } },
        h("button", {
          type: "button",
          onClick: openPersona,
          style: {
            padding: "3px 10px",
            fontSize: 10,
            fontWeight: 700,
            color: RECRUIT_LIGHT.onAccent,
            background: RECRUIT_LIGHT.accent,
            border: `1px solid ${RECRUIT_LIGHT.accent}`,
            cursor: "pointer",
          },
        }, "编辑人设"),
        h(
          "span",
          { style: { color: persona.text.trim() === "" ? RECRUIT_LIGHT.muted : RECRUIT_LIGHT.text } },
          persona.text.trim() === "" ? "还没有写" : `已写 ${Array.from(persona.text).length} 字`,
        ),
        persona.note ? h("span", { style: { fontSize: 10, color: RECRUIT_LIGHT.muted } }, persona.note) : null,
      ),
      h(
        "div",
        { style: { display: "flex", gap: 6, alignItems: "center" } },
        h("button", {
          type: "button",
          disabled: busy,
          onClick: save,
          style: {
            padding: "4px 14px",
            fontSize: 11,
            fontWeight: 700,
            color: RECRUIT_LIGHT.onAccent,
            background: RECRUIT_LIGHT.accent,
            border: `1px solid ${RECRUIT_LIGHT.accent}`,
            cursor: busy ? "wait" : "pointer",
          },
        }, "保存"),
        h("button", {
          type: "button",
          disabled: busy,
          onClick: toggleStatus,
          style: {
            padding: "4px 12px",
            fontSize: 11,
            color: RECRUIT_LIGHT.accent,
            background: "transparent",
            border: `1px solid ${RECRUIT_LIGHT.accent}`,
            cursor: busy ? "wait" : "pointer",
          },
        }, member.enabled === false ? "启用" : "停用"),
        h("button", {
          type: "button",
          disabled: busy,
          onClick: async () => {
            setNote("导出中…")
            try {
              const response = await fetch("/dsh-team/export-bot", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ bot: member.id }),
              })
              const data = await response.json()
              setNote(data?.ok ? `已导出到：${data.path}` : (data?.error ?? "导出失败"))
            } catch (error) {
              setNote(`导出失败：${error?.message ?? error}`)
            }
          },
          style: {
            padding: "4px 12px",
            fontSize: 11,
            color: RECRUIT_LIGHT.accent,
            background: "transparent",
            border: `1px solid ${RECRUIT_LIGHT.accent}`,
            cursor: busy ? "wait" : "pointer",
          },
        }, "导出"),
        h("button", {
          type: "button",
          onClick: () => onDone?.(),
          style: {
            padding: "4px 12px",
            fontSize: 11,
            color: RECRUIT_LIGHT.accent,
            background: "transparent",
            border: `1px solid ${RECRUIT_LIGHT.accent}`,
            cursor: "pointer",
          },
        }, "取消"),
        note ? h("span", { style: { fontSize: 10, color: RECRUIT_LIGHT.muted } }, note) : null,
      ),
    )
  }

  /**
   * 招募表单：组底下原地展开的新建界面，浅色，带模型下拉和能力卡。
   * @param props - { groupId, groupName, onDone }。
   */
  function RecruitInline({ groupId, groupName, onDone }) {
    const [form, setForm] = React.useState({
      id: "",
      name: "",
      role: "",
      model: "",
      allow: "",
      deny: "",
      note: "",
      stars: 0,
    })
    /** 还没建 Bot 就点「编辑人设」：在按钮右边提示一句，几秒后自己消失。 */
    const [personaHint, setPersonaHint] = React.useState("")
    const personaHintTimer = React.useRef(null)
    const [modelGroups, setModelGroups] = React.useState([])
    const [note, setNote] = React.useState("")
    const [busy, setBusy] = React.useState(false)
    const [avatar, setAvatar] = React.useState(null)
    const [avatarFile, setAvatarFile] = React.useState(null)

    React.useEffect(() => {
      let alive = true
      void (async () => {
        try {
          const response = await fetch("/dsh-team/models")
          const data = await response.json()
          if (alive && Array.isArray(data?.groups)) setModelGroups(data.groups)
        } catch {
          // 取不到就只留「跟随默认」
        }
      })()
      return () => {
        alive = false
      }
    }, [])

    const submit = async () => {
      if (busy) return
      setBusy(true)
      setNote("创建中…")
      try {
        const tools = {
          ...(form.allow.trim() === "" ? {} : { allow: form.allow.split(",").map((x) => x.trim()).filter(Boolean) }),
          ...(form.deny.trim() === "" ? {} : { deny: form.deny.split(",").map((x) => x.trim()).filter(Boolean) }),
        }
        const payload = {
          id: form.id,
          name: form.name,
          role: form.role,
          ...(form.model === "" ? {} : { model: form.model }),
          ...(form.note.trim() === "" ? {} : { note: form.note.trim() }),
          ...(form.stars > 0 ? { stars: form.stars } : {}),
          ...(Object.keys(tools).length === 0 ? {} : { capability: { tools } }),
          ...(groupId === "" ? {} : { group: groupId }),
        }
        const response = await fetch("/dsh-team/bots", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        })
        const data = await response.json()
        if (!data.ok) {
          setNote(data.error ?? "创建失败")
          return
        }
        if (avatar?.dataUrl) {
          try {
            const uploaded = await fetch("/dsh-team/avatar", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ bot: data.bot.id, dataUrl: avatar.dataUrl }),
            })
            const result = await uploaded.json()
            if (!result.ok) setNote(result.error ?? "头像上传失败，可稍后在设置里补")
          } catch {
            setNote("头像上传失败，可稍后在设置里补")
          }
        }
        onDone?.(data.bot)
      } catch (error) {
        setNote(`创建失败：${error?.message ?? error}`)
      } finally {
        setBusy(false)
      }
    }

    const field = (label, key, options = {}) => h(
      "label",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: 3,
          fontSize: 10,
          color: RECRUIT_LIGHT.muted,
        },
      },
      label,
      h(options.multiline ? "textarea" : "input", {
        value: form[key],
        rows: options.multiline ? 3 : undefined,
        placeholder: options.placeholder,
        onChange: (event) => setForm({ ...form, [key]: event.target.value }),
        style: {
          boxSizing: "border-box",
          width: "100%",
          padding: "4px 6px",
          fontSize: 11,
          fontFamily: "inherit",
          color: RECRUIT_LIGHT.text,
          background: RECRUIT_LIGHT.field,
          border: `1px solid ${RECRUIT_LIGHT.line}`,
          borderRadius: 0,
          resize: "vertical",
        },
      }),
    )

    return h(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: 5,
          padding: "9px 9px 10px",
          background: RECRUIT_LIGHT.bg,
        },
      },
      h(
        "div",
        { style: { color: RECRUIT_LIGHT.accent, fontSize: 11, fontWeight: 700, letterSpacing: "0.06em" } },
        `招募到：${groupName}`
      ),
      field("ID（小写字母/数字/短横线）", "id", { placeholder: "例如 aoi" }),
      field("名字", "name"),
      field("职责", "role"),
      h(
        "label",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 3,
            fontSize: 10,
            color: RECRUIT_LIGHT.muted,
          },
        },
        "模型（留空跟随默认）",
        h(
          "select",
          {
            value: form.model,
            onChange: (event) => setForm({ ...form, model: event.target.value }),
            style: {
              padding: "4px 6px",
              fontSize: 11,
              color: RECRUIT_LIGHT.text,
              background: RECRUIT_LIGHT.field,
              border: `1px solid ${RECRUIT_LIGHT.line}`,
              borderRadius: 0,
            },
          },
          h("option", { value: "" }, "跟随默认"),
          modelGroups.map((group) => h(
            "optgroup",
            { key: group.provider, label: group.name },
            (group.models ?? []).map((model) => h("option", { key: model.id, value: model.id }, model.name)),
          )),
        ),
      ),
      h(
        "label",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 10,
            color: RECRUIT_LIGHT.muted,
          },
        },
        "星级",
        h(StarPicker, {
          max: 4,
          value: form.stars,
          onChange: (stars) => setForm({ ...form, stars }),
        }),
        h("span", { style: { color: RECRUIT_LIGHT.muted } }, form.stars > 0 ? `${form.stars} 星` : "不评"),
      ),
      field("备注（显示在职责后面，可写文字或符号）", "note", { placeholder: "例如 主审 · 图纸" }),
      field("能力卡 · 只给这些工具（逗号分隔，留空=不限制）", "allow", { placeholder: "例如 read, grep, bash" }),
      field("能力卡 · 禁用这些工具（逗号分隔）", "deny"),
      // 人设只剩 memory/soul.txt 一份：招募时不写，建好之后去成员设置里「编辑人设」打开文件自己写。
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minHeight: 22 } },
        h("button", {
          type: "button",
          onClick: () => {
            setPersonaHint("请在创建BOT后再进行人设编辑")
            if (personaHintTimer.current) clearTimeout(personaHintTimer.current)
            personaHintTimer.current = setTimeout(() => setPersonaHint(""), 4000)
          },
          style: {
            padding: "3px 10px",
            fontSize: 10,
            fontWeight: 700,
            color: RECRUIT_LIGHT.onAccent,
            background: RECRUIT_LIGHT.accent,
            border: `1px solid ${RECRUIT_LIGHT.accent}`,
            cursor: "pointer",
          },
        }, "编辑人设"),
        h(
          "span",
          { style: { fontSize: 10, color: personaHint ? RECRUIT_LIGHT.accent : RECRUIT_LIGHT.muted } },
          personaHint || "人设只写在 txt 里，建好后从成员设置进入",
        ),
      ),
      avatarFile
        ? h(AvatarCropper, {
            file: avatarFile,
            onCancel: () => setAvatarFile(null),
            onCrop: (dataUrl) => {
              setAvatar({ name: avatarFile.name, dataUrl })
              setAvatarFile(null)
            },
          })
        : h(
            "label",
            {
              style: {
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 10,
                color: RECRUIT_LIGHT.muted,
              },
            },
            h(
              "span",
              {
                style: {
                  width: 34,
                  height: 34,
                  flex: "0 0 auto",
                  display: "grid",
                  placeItems: "center",
                  background: RECRUIT_LIGHT.field,
                  border: `1px solid ${RECRUIT_LIGHT.line}`,
                  overflow: "hidden",
                  fontSize: 10,
                  color: RECRUIT_LIGHT.muted,
                },
              },
              avatar?.dataUrl
                ? h("img", {
                    src: avatar.dataUrl,
                    alt: "",
                    style: { width: "100%", height: "100%", objectFit: "cover" },
                  })
                : "—",
            ),
            h(
              "span",
              { style: { display: "flex", flexDirection: "column", gap: 2 } },
              avatar?.dataUrl ? "头像（点这里可重新裁）" : "头像（可选，选图后拖动、缩放裁剪）",
              h("input", {
                type: "file",
                accept: "image/*",
                onChange: (event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ""
                  if (!file) return
                  if (!file.type.startsWith("image/")) {
                    setNote("这不是图片文件")
                    return
                  }
                  setAvatarFile(file)
                },
                style: { fontSize: 10, color: RECRUIT_LIGHT.text },
              }),
            ),
          ),
      h(
        "div",
        { style: { display: "flex", gap: 6, alignItems: "center" } },
        h(
          "button",
          {
            type: "button",
            disabled: busy,
            onClick: submit,
            style: {
              padding: "4px 14px",
              fontSize: 11,
              fontWeight: 700,
              color: RECRUIT_LIGHT.onAccent,
              background: RECRUIT_LIGHT.accent,
              border: `1px solid ${RECRUIT_LIGHT.accent}`,
              cursor: busy ? "wait" : "pointer",
            },
          },
          "招募"
        ),
        h(
          "button",
          {
            type: "button",
            onClick: () => onDone?.(null),
            style: {
              padding: "4px 12px",
              fontSize: 11,
              color: RECRUIT_LIGHT.accent,
              background: "transparent",
              border: `1px solid ${RECRUIT_LIGHT.accent}`,
              cursor: "pointer",
            },
          },
          "取消"
        ),
        note ? h("span", { style: { fontSize: 10, color: RECRUIT_LIGHT.muted } }, note) : null,
      ),
    )
  }
  /**
   * 招募条：默认收着，点击后原地展开。
   * @param props - { open, onToggle }。
   */
  /**
   * 招募条：默认收着，点击后原地展开。
   * 橙底上叠莱茵标志的浅水印和一小组等高线似的圆环。
   * @param props - { open, onToggle }。
   */
  /**
   * 招募条：默认收着，点击后原地展开。
   * 橙底上铺一层白色等高线，线条粗细不一、走向不规则。
   * @param props - { open, onToggle }。
   */
  /**
   * 招募条：默认收着，点击后原地展开。
   * @param props - { open, onToggle }。
   */
  function RecruitBar({ open, onToggle }) {
    return h(
      "button",
      {
        type: "button",
        onClick: onToggle,
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 5,
          width: "100%",
          height: 20,
          padding: 0,
          background: "#E77547",
          border: "none",
          cursor: "pointer",
          opacity: 0.92,
        },
      },
      h(
        "span",
        {
          style: {
            width: 13,
            height: 13,
            borderRadius: "50%",
            background: "#33302B",
            color: "#F4F1E4",
            display: "grid",
            placeItems: "center",
            fontSize: 10,
            lineHeight: "13px",
            fontWeight: 700,
          },
        },
        "+"
      ),
      h(
        "span",
        { style: { color: "#FBF7EC", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em" } },
        "招募员工"
      ),
    )
  }
  /** 档案里的日期只到天：YYYY-MM-DD。 */
  function dayOf(at) {
    const ts = Number(at)
    if (!Number.isFinite(ts) || ts <= 0) return '—'
    try {
      return new Date(ts).toISOString().slice(0, 10)
    } catch {
      return '—'
    }
  }

  /**
   * 成长档案：只读。评分样本、教学记录、带感言的晋升历史。
   * @param props - { member, onClose }。
   */
  function GrowthDialog({ member, onClose }) {
    const skin = useSkin()
    const p = palette()
    const [data, setData] = React.useState(null)
    const [error, setError] = React.useState('')
    // 确认守住之后重取一次；busyTag 记住哪一条在确认。
    const [version, setVersion] = React.useState(0)
    const [busyTag, setBusyTag] = React.useState('')
    const [flash, setFlash] = React.useState('')

    React.useEffect(() => {
      let alive = true
      void (async () => {
        try {
          const response = await fetch(`/dsh-team/growth?bot=${encodeURIComponent(member?.id ?? '')}`)
          const payload = await response.json()
          if (!alive) return
          if (!payload?.ok) {
            setError(payload?.error ?? '读取失败')
            return
          }
          setData(payload)
        } catch (err) {
          if (alive) setError(String(err?.message ?? err))
        }
      })()
      return () => {
        alive = false
      }
    }, [member?.id, version])

    /** 确认一条教过的规矩守住了：服务端还会再判一次条件。 */
    const confirmTeach = async (tag) => {
      setFlash('')
      setBusyTag(tag)
      try {
        const response = await fetch('/dsh-team/improve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ bot: member?.id, tag }),
        })
        const payload = await response.json()
        if (!payload?.ok) {
          setFlash(payload?.error ?? '确认失败')
          return
        }
        setFlash(`「${tag}」算守住了，+${payload.gained} 经验`)
        setVersion((value) => value + 1)
      } catch (err) {
        setFlash(String(err?.message ?? err))
      } finally {
        setBusyTag('')
      }
    }

    const summary = data?.summary
    const stats = data?.stats ?? {}
    const teaches = Array.isArray(data?.teaches) ? data.teaches : []
    const promotions = Array.isArray(data?.promotions) ? data.promotions : []
    const capped = summary?.capped === true
    const need = Number(summary?.need) || 0
    const into = Number(summary?.into) || 0
    const barPercent = capped ? 100 : need > 0 ? Math.min(100, Math.round((into / need) * 100)) : 0

    const section = (title, children) => h(
      'div',
      { style: { marginTop: 14 } },
      h('div', { style: { fontSize: 10, letterSpacing: '0.12em', color: p.dim } }, title),
      children,
    )

    return h(
      'div',
      {
        style: { position: 'fixed', inset: 0, zIndex: 62, display: 'grid', placeItems: 'center', background: 'rgba(20,22,20,0.42)' },
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose?.()
        },
      },
      h(
        'div',
        {
          role: 'dialog',
          'aria-modal': true,
          'aria-label': '成长档案',
          style: {
            width: 'calc(100% - 24px)',
            maxWidth: 400,
            maxHeight: '82vh',
            overflow: 'auto',
            padding: '14px',
            background: p.surface,
            border: `1px solid ${p.line}`,
            borderRadius: p.radius === 2 ? 2 : 10,
            boxShadow: '0 12px 32px rgba(0,0,0,0.24)',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
          h('span', { style: { fontSize: 13, fontWeight: 700, color: p.text } }, data?.bot?.name || member?.name || member?.id),
          h('span', { style: { fontSize: 11, color: p.dim } }, data?.bot?.role || member?.role || ''),
          h('button', {
            type: 'button',
            'aria-label': '关闭',
            onClick: onClose,
            style: { marginLeft: 'auto', padding: '0 2px', fontSize: 14, lineHeight: '18px', color: p.dim, background: 'transparent', border: 'none', cursor: 'pointer' },
          }, '×'),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
          h('span', { style: { ...rankStyle(summary?.rank, p), padding: '1px 8px', fontSize: 11 } }, rankLabel(summary?.rank)),
          h('span', { style: { fontSize: 11, color: p.text } }, `LV.${Number(summary?.level) || 1}`),
          Number(data?.bot?.stars) > 0 ? h(StarsRow, { count: Number(data.bot.stars), size: 11 }) : null,
          h('span', { style: { marginLeft: 'auto', fontSize: 10, color: p.faint } },
            capped ? '已满级' : `${into} / ${need}`),
        ),
        h(
          'div',
          { style: { marginTop: 6, height: 5, borderRadius: 999, background: p.line, overflow: 'hidden' } },
          h('div', { style: { width: `${barPercent}%`, height: '100%', background: rankDotColor(summary?.rank) } }),
        ),
        error !== '' ? h('div', { style: { marginTop: 12, fontSize: 11, color: p.warn } }, `读取失败：${error}`) : null,
        data === null && error === ''
          ? h('div', { style: { marginTop: 12, fontSize: 11, color: p.faint } }, '读取中…')
          : null,
        data === null ? null : section(
          '评分样本',
          h('div', null,
            h('div', { style: { marginTop: 4, fontSize: 11, color: p.text } },
              `优秀 ${Number(stats.excellent) || 0} · 良好 ${Number(stats.good) || 0} · 合格 ${Number(stats.pass) || 0} · 差评 ${Number(stats.poor) || 0} · 复犯 ${Number(stats.repeats) || 0}`),
            h('div', { style: { marginTop: 2, fontSize: 10, color: p.dim } },
              `好评率 ${percent(summary?.goodRate)} · 复犯率 ${percent(summary?.repeatRate)} · 连击 ${Number(summary?.streak) || 0}`),
          ),
        ),
        data === null ? null : section(
          `教学记录（${teaches.length}）`,
          teaches.length === 0
            ? h('div', { style: { marginTop: 4, fontSize: 11, color: p.faint } }, '还没教过规矩')
            : h('div', null, teaches.slice().reverse().slice(0, 6).map((entry) => h(
              'div',
              { key: `${entry.tag}-${entry.at}`, style: { marginTop: 6, fontSize: 11, lineHeight: 1.6 } },
              h('div', { style: { color: p.dim } }, `${dayOf(entry.at)} · [${entry.tag}]`),
              h('div', { style: { color: p.text, wordBreak: 'break-word' } }, entry.text ?? ''),
              h(
                'div',
                { style: { marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 } },
                entry.canConfirm
                  ? h('button', {
                      type: 'button',
                      disabled: busyTag === entry.tag,
                      title: `确认它守住了「${entry.tag}」：+120 经验`,
                      onClick: () => void confirmTeach(entry.tag),
                      style: {
                        padding: '1px 8px',
                        fontSize: 10,
                        color: p.accent,
                        background: 'transparent',
                        border: `1px solid ${p.accent}`,
                        borderRadius: 999,
                        cursor: busyTag === entry.tag ? 'progress' : 'pointer',
                      },
                    }, busyTag === entry.tag ? '确认中…' : '确认守住 +120')
                  : h('span', { style: { fontSize: 10, color: p.faint } },
                    entry.confirmedAt ? `已守住（${dayOf(entry.confirmedAt)}）` : (entry.reason ?? '还不能确认')),
              ),
            ))),
        ),
        flash !== '' ? h('div', { style: { marginTop: 8, fontSize: 10, color: p.accent } }, flash) : null,
        data === null ? null : section(
          `晋升历史（${promotions.length}）`,
          promotions.length === 0
            ? h('div', { style: { marginTop: 4, fontSize: 11, color: p.faint } }, '还没晋升过')
            : h('div', null, promotions.slice().reverse().map((entry) => h(
              'div',
              { key: `p-${entry.at}`, style: { marginTop: 6, fontSize: 11, lineHeight: 1.65 } },
              h('div', { style: { color: p.dim } },
                `${dayOf(entry.at)} · ${rankLabel(entry.from)} → ${rankLabel(entry.to)}`),
              entry.speech
                ? h('div', { style: { color: p.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, `「${entry.speech}」`)
                : h('div', { style: { color: p.faint } }, '这次没写感言'),
            ))),
        ),
      ),
    )
  }

  /**
   * 晋升确认：同样的 Rhine 横条，绿底、深色标题、灰色加号水印。
   * @param props - { member, onCancel, onConfirm }。
   */
  /**
   * 晋升：一个框走完全程，不再「关掉框等几秒再弹感言」。
   *
   * 阶段：confirm（问一遍）→ working（转圈等感言）→ reveal（逐字出感言）→ done（成功摘要）。
   * @param props - `{ member, onCancel, onRun }`；`onRun` 返回 `{ ok, error?, label?, rank?, speech?, speechError? }`。
   */
  function PromoteDialog({ member, onCancel, onRun }) {
    const [phase, setPhase] = React.useState('confirm')
    const [result, setResult] = React.useState(null)
    const [error, setError] = React.useState('')
    const [shown, setShown] = React.useState(0)

    const lv = Number(member?.lv) || 0
    const teaches = Number(member?.teaches) || 0
    const nextRank = (Number(member?.rank) || 0) + 1
    const speech = typeof result?.speech === 'string' ? result.speech : ''

    // 逐字吐字：感言到手之后才跑，快一点（每 16ms 两个字符）。
    React.useEffect(() => {
      if (phase !== 'reveal' || speech === '') return undefined
      let index = 0
      const timer = setInterval(() => {
        index = Math.min(speech.length, index + 2)
        setShown(index)
        if (index >= speech.length) {
          clearInterval(timer)
          setPhase('done')
        }
      }, 16)
      return () => clearInterval(timer)
    }, [phase, speech])

    const run = async () => {
      const startedAt = Date.now()
      setPhase('working')
      setError('')
      try {
        const payload = await onRun?.(member)
        if (!payload?.ok) {
          setError(payload?.error ?? '晋升失败')
          setPhase('error')
          return
        }
        // 感言是现成的（抄人设或固定句）：动效至少转 3 秒，别一闪而过。
        const left = 3000 - (Date.now() - startedAt)
        if (left > 0) await new Promise((resolve) => { setTimeout(resolve, left) })
        setResult(payload)
        if (typeof payload.speech === 'string' && payload.speech.trim() !== '') {
          setShown(0)
          setPhase('reveal')
          return
        }
        setPhase('done')
      } catch (failure) {
        setError(String(failure?.message ?? failure))
        setPhase('error')
      }
    }

    const busy = phase === 'working' || phase === 'reveal'
    // 星级上限 4 / 5 / 6 跟段位；等级上限 49（二阶 90）。
    const starCapOf = (rank) => (rank >= 2 ? 6 : rank === 1 ? 5 : 4)
    const starCapBefore = starCapOf(Number(member?.rank) || 0)
    const starCapAfter = starCapOf(nextRank)
    const levelCapText = nextRank >= 2 ? '等级上限提到 90' : '等级上限提到 50'

    // 那圈转环 + 箭头：正在晋升和已晋升完成都用它，只是左边那行字不同。
    const runningMark = h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '2px 0 4px' } },
      h(
        'div',
        { style: { position: 'relative', width: 34, height: 34, flex: '0 0 auto' } },
        h('div', {
          'aria-hidden': true,
          style: {
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            background: 'conic-gradient(from 0deg, rgba(242,242,242,0) 0deg, rgba(242,242,242,0.95) 110deg, rgba(242,242,242,0.06) 210deg, rgba(242,242,242,0) 360deg)',
            animation: 'dshTeamPromoteSpin 1.5s linear infinite',
          },
        }),
        h('div', {
          'aria-hidden': true,
          style: { position: 'absolute', inset: 3, borderRadius: '50%', background: '#6A9842' },
        }),
        h(
          'div',
          {
            'aria-hidden': true,
            style: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', animation: 'dshTeamPromoteBreathe 1.6s ease-in-out infinite' },
          },
          h(
            'svg',
            { width: 14, height: 14, viewBox: '0 0 24 24', style: { display: 'block' } },
            // 向上的箭头：三角头 + 竖杆。
            h('g', { fill: '#F4F1E4' }, h('path', { d: 'M12 2.5 L20 11 h-5 v10 h-6 V11 H4 z' })),
          ),
        ),
      ),
      h(
        'div',
        { style: { minWidth: 0 } },
        h(
          'div',
          { style: { color: '#F4F1E4', fontSize: 13, fontWeight: 700, lineHeight: 1.5 } },
          phase === 'working' ? '正在晋升…' : '已晋升完成！',
        ),
        // 三色线条一直在：等待时闪，完成之后留成静的。
        h(
          'div',
          { style: { display: 'flex', gap: 3, marginTop: 4 } },
          ['#86C1AF', '#EBA93F', '#992C27'].map((color, index) => h('span', {
            key: color,
            'aria-hidden': true,
            style: {
              width: 16,
              height: 3,
              background: color,
              ...(phase === 'working'
                ? {
                  animation: 'dshTeamPromoteBreathe 1.2s ease-in-out infinite',
                  animationDelay: `${index * 0.18}s`,
                }
                : {}),
            },
          })),
        ),
      ),
    )

    // 抬头写清是谁说的：名字@id，感言本身还在下面挂着。
    const speakerLabel = `${member?.name || member?.id || ''}@${member?.id ?? ''}：`
    const speechBlock = h(
      'blockquote',
      {
        style: {
          margin: '6px 0 0',
          paddingLeft: 9,
          borderLeft: '2px solid rgba(244,241,228,0.6)',
          color: '#F4F1E4',
          fontSize: 12,
          lineHeight: 1.75,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          minHeight: phase === 'reveal' ? 40 : undefined,
        },
      },
      h('div', {
        key: 'who',
        style: { fontSize: 11, color: 'rgba(244,241,228,0.75)', letterSpacing: 0.2, marginBottom: 2 },
      }, speakerLabel),
      h('div', { key: 'text' }, `「${phase === 'reveal' ? speech.slice(0, shown) : speech}」`),
    )

    return h(
      'div',
      {
        style: { position: 'fixed', inset: 0, zIndex: 60, display: 'grid', placeItems: 'center', background: 'rgba(20,22,20,0.42)' },
        onMouseDown: (event) => {
          // 忙的时候点背景不关，免得误触把流程掐断。
          if (!busy && event.target === event.currentTarget) onCancel?.()
        },
      },
      h(
        'div',
        {
          role: 'dialog',
          'aria-modal': true,
          'aria-label': '晋升',
          style: {
            position: 'relative',
            width: 'calc(100% - 28px)',
            maxWidth: 340,
            overflow: 'hidden',
            border: '1px solid #303332',
            background: '#6A9842',
            boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
          },
        },
        // 水印：莱茵标志。
        h(
          'svg',
          {
            'aria-hidden': true,
            viewBox: '40 30 1030 502',
            style: { position: 'absolute', right: -22, top: 34, width: 168, height: 84, opacity: 0.16, pointerEvents: 'none' },
          },
          h(
            'g',
            { fill: 'none', stroke: '#F2F2F2', strokeWidth: 76, strokeLinejoin: 'round', strokeLinecap: 'round' },
            h('path', {
              d: 'M552 266 L409.5219 134.4781 A186 186 0 1 0 409.5219 397.5219 L552 266 L695.4781 134.4781 A186 186 0 1 1 695.4781 397.5219 L552 266 Z',
              strokeDasharray: '2380.3364 150',
              strokeDashoffset: 1065.3364,
            }),
          ),
          h('g', { fill: '#F2F2F2' },
            h('path', { d: 'M222 245h150v42H222z M276 191h42v150h-42z' }),
            h('path', { d: 'M752 245h136v42H752z' }),
          ),
        ),
        h(
          'div',
          { style: { position: 'relative', display: 'flex', alignItems: 'center', height: 26, padding: '0 8px', background: '#303332' } },
          ['#86C1AF', '#EBA93F', '#992C27'].map((color, index) => h('span', {
            key: index,
            'aria-hidden': true,
            style: { width: 3, height: 26, flex: '0 0 auto', background: color },
          })),
          h('span', { style: { marginLeft: 8, display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontWeight: 700, letterSpacing: '0.18em' } },
            h('span', { style: { color: '#F2F2F2' } }, 'RHINE LAB'),
            h('span', { style: { color: '#EBA93F' } }, 'PROMOTION'),
          ),
          busy
            ? null
            : h('button', {
              type: 'button',
              'aria-label': '关闭',
              onClick: onCancel,
              style: { marginLeft: 'auto', padding: '0 2px', fontSize: 14, lineHeight: '18px', color: '#F2F2F2', background: 'transparent', border: 'none', cursor: 'pointer' },
            }, '×'),
        ),
        h(
          'div',
          { style: { position: 'relative', padding: '14px 12px 10px' } },
          // ---- 确认 ----
          phase === 'confirm'
            ? [
              h('div', { key: 'q', style: { color: '#F4F1E4', fontSize: 13, fontWeight: 700, lineHeight: 1.55 } },
                `晋升「${member?.name || member?.id}」为${rankLabel(nextRank)}？`),
              h('div', { key: 'd', style: { marginTop: 4, color: '#EDE9D9', fontSize: 11, lineHeight: 1.5 } },
                `LV.${lv} 归零，经验重新积累；${teaches} 条教学记录与晋升历史保留。`),
              h('div', { key: 'b', style: { display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 14 } },
                h('button', {
                  type: 'button',
                  onClick: onCancel,
                  style: { padding: '3px 12px', fontSize: 12, color: '#F4F1E4', background: 'transparent', border: '1px solid rgba(244,241,228,0.7)', cursor: 'pointer' },
                }, '再等等'),
                h('button', {
                  type: 'button',
                  onClick: run,
                  style: { padding: '3px 14px', fontSize: 12, fontWeight: 700, color: '#2E3A2A', background: '#F4F1E4', border: '1px solid #F4F1E4', cursor: 'pointer' },
                }, '晋升'),
              ),
            ]
            : null,
          // ---- 动效：等待和完成都在，只是文案和下面的内容不同 ----
          phase === 'working' || phase === 'reveal' || phase === 'done'
            ? h(
              'div',
              null,
              runningMark,
              phase === 'reveal' || phase === 'done' ? speechBlock : null,
              phase === 'done'
                ? h(
                  'div',
                  null,
                  speech === ''
                    ? h('div', { style: { marginTop: 6, color: '#EDE9D9', fontSize: 11, lineHeight: 1.5 } },
                      result?.speechError ? `这次没写感言：${result.speechError}` : '这次没写感言。')
                    : null,
                  h(
                    'div',
                    { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: '#EDE9D9', lineHeight: 1.6 } },
                    h('div', null, `星级上限：${starCapBefore} → ${starCapAfter} 星（已自动设为 ${starCapAfter} 星）`),
                    h('div', null, levelCapText),
                    h('div', null, '经验与等级归零，从 LV.1 重新起算'),
                    // 一阶起才能给卡片设背景图（服务端同样拦着）。
                    nextRank === 1
                      ? h('div', null, '解锁：人物卡背景图（精英化一阶起可设）')
                      : null,
                  ),
                  h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 14 } },
                    h('button', {
                      type: 'button',
                      onClick: onCancel,
                      style: { padding: '3px 14px', fontSize: 12, fontWeight: 700, color: '#2E3A2A', background: '#F4F1E4', border: '1px solid #F4F1E4', cursor: 'pointer' },
                    }, '确定'),
                  ),
                )
                : null,
            )
            : null,
          // ---- 出错 ----
          phase === 'error'
            ? h(
              'div',
              null,
              h('div', { style: { color: '#F4F1E4', fontSize: 13, fontWeight: 700, lineHeight: 1.55 } }, '晋升没成'),
              h('div', { style: { marginTop: 4, color: '#EDE9D9', fontSize: 11, lineHeight: 1.5 } }, error),
              h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 14 } },
                h('button', {
                  type: 'button',
                  onClick: onCancel,
                  style: { padding: '3px 12px', fontSize: 12, color: '#F4F1E4', background: 'transparent', border: '1px solid rgba(244,241,228,0.7)', cursor: 'pointer' },
                }, '关闭'),
                h('button', {
                  type: 'button',
                  onClick: run,
                  style: { padding: '3px 14px', fontSize: 12, fontWeight: 700, color: '#2E3A2A', background: '#F4F1E4', border: '1px solid #F4F1E4', cursor: 'pointer' },
                }, '再试一次'),
              ),
            )
            : null,
        ),
      ),
    )
  }

  /**
   * 删除分组的确认框：横条，Rhine Lab 的绿底 + 深色标题 + 灰色加号水印。
   * @param props - { group, onCancel, onConfirm }。
   */
  /**
   * 莱茵确认卡：绿底、深色标题条、水印，取消 / 确认两个按钮。
   * 删分组和删成员共用这一张，只是文案不同。
   * @param props - `{ ariaLabel, title, body, confirmText, onCancel, onConfirm }`。
   */
  function RhineConfirmDialog({ ariaLabel, title, body, confirmText, onCancel, onConfirm }) {
    return h(
      'div',
      {
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 60,
          display: 'grid',
          placeItems: 'center',
          background: 'rgba(20, 22, 20, 0.42)',
        },
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onCancel?.()
        },
      },
      h(
        'div',
        {
          role: 'dialog',
          'aria-modal': true,
          'aria-label': ariaLabel,
          style: {
            position: 'relative',
            width: 'calc(100% - 28px)',
            maxWidth: 340,
            overflow: 'hidden',
            border: '1px solid #303332',
            background: '#6A9842',
            boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
          },
        },
        // 莱茵生命的标志（hero mark）：缎带环 + 十字，做水印。
        h(
          'svg',
          {
            'aria-hidden': true,
            viewBox: '40 30 1030 502',
            style: {
              position: 'absolute',
              right: -22,
              top: 34,
              width: 168,
              height: 84,
              opacity: 0.16,
              pointerEvents: 'none',
            },
          },
          h(
            'g',
            { fill: 'none', stroke: '#F2F2F2', strokeWidth: 76, strokeLinejoin: 'round', strokeLinecap: 'round' },
            h('path', { d: 'M552 266 L409.5219 134.4781 A186 186 0 1 0 409.5219 397.5219 L552 266 L695.4781 134.4781 A186 186 0 1 1 695.4781 397.5219 L552 266 Z', strokeDasharray: '2380.3364 150', strokeDashoffset: 1065.3364 }),
          ),
          h(
            'g',
            { fill: '#F2F2F2' },
            h('path', { d: 'M222 245h150v42H222z M276 191h42v150h-42z' }),
            h('path', { d: 'M752 245h136v42H752z' }),
          ),
        ),
        h(
          'div',
          {
            style: {
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              height: 26,
              padding: '0 8px',
              background: '#303332',
            },
          },
          ['#86C1AF', '#EBA93F', '#992C27'].map((color, index) => h('span', {
            key: index,
            'aria-hidden': true,
            style: { width: 3, height: 26, flex: '0 0 auto', background: color },
          })),
          h(
            'span',
            {
              style: {
                marginLeft: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.18em',
              },
            },
            h('span', { style: { color: '#F2F2F2' } }, 'RHINE LAB'),
            h('span', { style: { color: '#EBA93F' } }, 'WARNING'),
          ),
          h(
            'button',
            {
              type: 'button',
              'aria-label': '关闭',
              onClick: onCancel,
              style: {
                marginLeft: 'auto',
                padding: '0 2px',
                fontSize: 14,
                lineHeight: '18px',
                color: '#F2F2F2',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              },
            },
            '×',
          ),
        ),
        h(
          'div',
          { style: { position: 'relative', padding: '14px 12px 10px' } },
          h(
            'div',
            { style: { color: '#F4F1E4', fontSize: 13, fontWeight: 700, lineHeight: 1.55 } },
            title,
          ),
          h(
            'div',
            { style: { marginTop: 4, color: '#EDE9D9', fontSize: 11, lineHeight: 1.5 } },
            body,
          ),
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 14 } },
            h(
              'button',
              {
                type: 'button',
                onClick: onCancel,
                style: {
                  padding: '3px 12px',
                  fontSize: 12,
                  color: '#F4F1E4',
                  background: 'transparent',
                  border: '1px solid rgba(244,241,228,0.7)',
                  cursor: 'pointer',
                },
              },
              '取消',
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: onConfirm,
                style: {
                  padding: '3px 14px',
                  fontSize: 12,
                  fontWeight: 700,
                  color: '#2E3A2A',
                  background: '#F4F1E4',
                  border: '1px solid #F4F1E4',
                  cursor: 'pointer',
                },
              },
              confirmText,
            ),
          ),
        ),
      ),
    )
  }

  /**
   * 删除分组的确认框：横条，Rhine Lab 的绿底 + 深色标题 + 灰色加号水印。
   * @param props - `{ group, onCancel, onConfirm }`。
   */
  function ConfirmGroupDialog({ group, onCancel, onConfirm }) {
    return h(RhineConfirmDialog, {
      ariaLabel: '确认删除分组',
      title: `删除「${group?.name ?? ''}」？`,
      body: '组里的 Bot 会回到行动预备组。',
      confirmText: '删除',
      onCancel,
      onConfirm: () => onConfirm?.(group),
    })
  }

  /**
   * 彻底删除成员的确认框：和删分组同一张卡。
   * 自带的 Bot 多一段说明——告诉用户它是干什么的，并建议别删。
   * @param props - `{ member, onCancel, onConfirm }`。
   */
  function ConfirmRemoveDialog({ member, onCancel, onConfirm }) {
    const builtin = member?.builtin === true
    const isAuditor = member?.id === 'auditor'
    return h(RhineConfirmDialog, {
      ariaLabel: '确认彻底删除',
      title: `彻底删除「${member?.name || member?.id}」？`,
      body: isAuditor
        ? '审计员负责在交付前将智能体的错漏挑出，建议不予删除，该审计员为特殊BOT，删除后可找回。'
        : builtin
          ? '这是插件自带的 Bot。它的记忆、头像、背景图会一起删掉，删了不能恢复。'
          : '它的记忆、头像、背景图会一起删掉，删了不能恢复。',
      confirmText: builtin ? '仍然删除' : '删除',
      onCancel,
      onConfirm: () => onConfirm?.(member),
    })
  }


  /**
   * 团队知识库：三份共用文件（团队知识 / 关于用户 / 写作规矩）的编辑器。
   * 存在 `bots/_team/*.md`，写进去以后所有 Bot 与秘书下一轮就按它干活。
   * @param props - `{ onClose, onSaved }`。
   */
  function TeamKnowledgeDialog({ onClose, onSaved }) {
    const p = palette()
    const FILES = [
      { id: 'knowledge', label: '团队知识' },
      { id: 'user', label: '关于用户' },
      { id: 'style', label: '交付规范' },
    ]
    const [file, setFile] = React.useState('knowledge')
    const [text, setText] = React.useState('')
    const [status, setStatus] = React.useState('')
    const [busy, setBusy] = React.useState(false)

    const load = React.useCallback(async (name) => {
      setStatus('读取中…')
      try {
        const response = await fetch(`/dsh-team/team-memory?file=${encodeURIComponent(name)}`)
        const data = await response.json()
        setText(typeof data?.text === 'string' ? data.text : '')
        setStatus(data?.ok ? '' : (data?.error ?? '读取失败'))
      } catch (error) {
        setStatus(`读取失败：${error?.message ?? error}`)
      }
    }, [])

    React.useEffect(() => {
      void load(file)
    }, [file, load])

    const save = async () => {
      setBusy(true)
      setStatus('保存中…')
      try {
        const response = await fetch('/dsh-team/team-memory', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file, text }),
        })
        const data = await response.json()
        if (!data?.ok) {
          setStatus(data?.error ?? '保存失败')
          return
        }
        setStatus(`已保存（${data.chars} 字）`)
        onSaved?.()
      } catch (error) {
        setStatus(`保存失败：${error?.message ?? error}`)
      } finally {
        setBusy(false)
      }
    }

    return h(
      'div',
      {
        style: { position: 'fixed', inset: 0, zIndex: 60, display: 'grid', placeItems: 'center', background: 'rgba(20,22,20,0.42)' },
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose?.()
        },
      },
      h(
        'div',
        {
          role: 'dialog',
          'aria-modal': true,
          'aria-label': '团队知识库',
          style: {
            width: 'calc(100% - 28px)',
            maxWidth: 520,
            maxHeight: 'calc(100% - 60px)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '12px 12px 10px',
            background: p.surface,
            border: `1px solid ${p.line}`,
            borderRadius: 6,
            color: p.text,
          },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700 } },
          h('span', null, '团队知识库'),
          h('span', { style: { flex: '1 1 auto' } }),
          h('button', {
            type: 'button',
            'aria-label': '关闭',
            onClick: onClose,
            style: { padding: '0 4px', fontSize: 14, background: 'transparent', border: 'none', color: p.dim, cursor: 'pointer' },
          }, '×'),
        ),
        h('div', { style: { display: 'flex', gap: 6 } },
          FILES.map((entry) => h('button', {
            key: entry.id,
            type: 'button',
            onClick: () => setFile(entry.id),
            style: {
              padding: '2px 8px',
              fontSize: 11,
              color: file === entry.id ? p.text : p.faint,
              background: 'transparent',
              border: `1px solid ${file === entry.id ? p.accent : p.line}`,
              borderRadius: 4,
              cursor: 'pointer',
            },
          }, entry.label)),
        ),
        h('textarea', {
          value: text,
          spellCheck: false,
          onChange: (event) => setText(event.target.value),
          style: {
            flex: '1 1 auto',
            minHeight: 240,
            padding: 8,
            fontSize: 12,
            lineHeight: 1.6,
            fontFamily: 'inherit',
            color: p.text,
            background: p.raised,
            border: `1px solid ${p.line}`,
            borderRadius: 4,
            resize: 'vertical',
            boxSizing: 'border-box',
          },
        }),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: p.faint } },
          h('span', null, status),
          h('span', { style: { flex: '1 1 auto' } }),
          h('button', {
            type: 'button',
            onClick: onClose,
            style: { padding: '3px 12px', fontSize: 12, color: p.text, background: 'transparent', border: `1px solid ${p.line}`, borderRadius: 4, cursor: 'pointer' },
          }, '取消'),
          h('button', {
            type: 'button',
            disabled: busy,
            onClick: save,
            style: { padding: '3px 14px', fontSize: 12, fontWeight: 700, color: p.ink ?? p.text, background: p.accent, border: `1px solid ${p.accent}`, borderRadius: 4, cursor: busy ? 'wait' : 'pointer' },
          }, '保存'),
        ),
      ),
    )
  }

  /**
   * 使用说明：把 docs/QUICKSTART.md 原样显示出来。
   * @param props - `{ onClose }`。
   */
  function QuickstartDialog({ onClose }) {
    const p = palette()
    const [text, setText] = React.useState('读取中…')
    React.useEffect(() => {
      let alive = true
      fetch('/dsh-team/quickstart')
        .then((response) => response.json())
        .then((data) => {
          if (!alive) return
          setText(data?.ok ? String(data.text ?? '') : (data?.error ?? '读不到使用说明'))
        })
        .catch((error) => {
          if (alive) setText(`读不到使用说明：${error?.message ?? error}`)
        })
      return () => { alive = false }
    }, [])
    return h(
      'div',
      {
        style: { position: 'fixed', inset: 0, zIndex: 60, display: 'grid', placeItems: 'center', background: 'rgba(20,22,20,0.42)' },
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose?.() },
      },
      h(
        'div',
        {
          role: 'dialog',
          'aria-modal': true,
          'aria-label': '使用说明',
          style: {
            width: 'calc(100% - 28px)',
            maxWidth: 560,
            maxHeight: 'calc(100% - 60px)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '12px 12px 10px',
            overflow: 'hidden',
            background: p.surface,
            border: `1px solid ${p.line}`,
            color: p.text,
          },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700 } },
          h('span', null, '使用说明'),
          h('span', { style: { flex: '1 1 auto' } }),
          h('button', {
            type: 'button',
            'aria-label': '关闭',
            onClick: onClose,
            style: { padding: '0 4px', fontSize: 14, background: 'transparent', border: 'none', color: p.dim, cursor: 'pointer' },
          }, '×'),
        ),
        h('pre', {
          style: {
            flex: '1 1 auto',
            minHeight: 0,
            margin: 0,
            overflow: 'auto',
            overscrollBehavior: 'contain',
            fontSize: 11,
            lineHeight: 1.7,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: p.dim,
            fontFamily: 'inherit',
          },
        }, text),
      ),
    )
  }

  /** 书本图标：和锤子同一套画法（24 网格、实心、同色）。 */
  function BookIcon({ size = 13, color = '#F2672E' }) {
    return h(
      'svg',
      {
        'aria-hidden': true,
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: color,
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style: { display: 'block', flex: '0 0 auto' },
      },
      h('path', { d: 'M3 5.5A2.5 2.5 0 0 1 5.5 3H10v17H5.5A2.5 2.5 0 0 0 3 22z' }),
      h('path', { d: 'M21 5.5A2.5 2.5 0 0 0 18.5 3H14v17h4.5A2.5 2.5 0 0 1 21 22z' }),
    )
  }

  /**
   * 任务依赖图：按 chainId 取一条链，按深度从左到右排；只读，不做拖拽。
   * 画布是辅助视图，真正的调度仍在 host 的依赖队列里。
   */
  function TaskGraphDialog({ tasks, onClose, p }) {
    const byChain = new Map()
    for (const task of tasks ?? []) {
      const chainId = String(task.chainId ?? task.taskId ?? '')
      if (chainId === '') continue
      if (!byChain.has(chainId)) byChain.set(chainId, [])
      byChain.get(chainId).push(task)
    }
    const chains = [...byChain.values()]
    const withEdges = chains.filter((list) => list.some((task) => (task.dependsOn ?? []).length > 0))
    const picked = (withEdges.length > 0 ? withEdges : chains)
      .sort((a, b) => Math.max(...b.map((t) => t.startedAt ?? 0)) - Math.max(...a.map((t) => t.startedAt ?? 0)))[0] ?? []
    const ids = new Set(picked.map((task) => task.taskId))
    const edges = []
    for (const task of picked) {
      for (const dep of task.dependsOn ?? []) {
        if (ids.has(dep)) edges.push([dep, task.taskId])
      }
    }
    const depth = new Map(picked.map((task) => [task.taskId, 0]))
    for (let round = 0; round < picked.length; round += 1) {
      let changed = false
      for (const task of picked) {
        for (const dep of task.dependsOn ?? []) {
          if (!ids.has(dep)) continue
          const next = (depth.get(dep) ?? 0) + 1
          if (next > (depth.get(task.taskId) ?? 0)) {
            depth.set(task.taskId, next)
            changed = true
          }
        }
      }
      if (!changed) break
    }
    const cols = new Map()
    for (const task of picked) {
      const d = depth.get(task.taskId) ?? 0
      if (!cols.has(d)) cols.set(d, [])
      cols.get(d).push(task)
    }
    const maxDepth = Math.max(0, ...[...cols.keys()])
    const maxRows = Math.max(1, ...[...cols.values()].map((list) => list.length))
    const width = 80 + (maxDepth + 1) * 150
    const height = 58 + maxRows * 54
    const colorOf = (status) => {
      if (status === 'accepted') return '#5C8A4A'
      if (status === 'ready') return '#B07A2A'
      if (status === 'blocked' || status === 'failed' || status === 'rejected') return '#A14032'
      if (status === 'running') return '#2F6B6B'
      return '#7A807A'
    }
    const pos = new Map()
    for (const [d, list] of cols) {
      list.forEach((task, row) => {
        pos.set(task.taskId, { x: 18 + d * 150, y: 18 + row * 54 })
      })
    }
    return h(
      'div',
      {
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 80,
          background: 'rgba(28,30,28,0.42)',
          display: 'grid',
          placeItems: 'center',
          padding: 18,
        },
        onClick: onClose,
      },
      h(
        'div',
        {
          onClick: (event) => event.stopPropagation(),
          style: {
            width: 'min(92vw, 560px)',
            maxHeight: '82vh',
            overflow: 'auto',
            background: '#F6F1E5',
            border: '1px solid #E4DCC9',
            borderRadius: 12,
            padding: 14,
            boxShadow: '0 18px 50px rgba(0,0,0,0.22)',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          h('strong', { style: { fontSize: 13, color: '#292923' } }, '任务依赖图'),
          h('span', { style: { fontSize: 10, color: p.faint } }, picked.length ? `链 ${picked[0].chainId ?? picked[0].taskId} · ${picked.length} 件` : '还没有任务'),
          h('button', {
            type: 'button',
            onClick: onClose,
            style: { marginLeft: 'auto', border: 0, background: 'transparent', color: p.dim, cursor: 'pointer', fontSize: 14 },
          }, '×'),
        ),
        picked.length === 0
          ? h('div', { style: { padding: '24px 8px', fontSize: 11, color: p.faint } }, '还没有可画的任务。先派一件活。')
          : h(
              'svg',
              { width: '100%', viewBox: `0 0 ${width} ${height}`, style: { display: 'block' } },
              h(
                'defs',
                null,
                h('marker', {
                  id: 'dsh-team-arrow',
                  markerWidth: 8,
                  markerHeight: 8,
                  refX: 7,
                  refY: 4,
                  orient: 'auto',
                }, h('path', { d: 'M0 0 L8 4 L0 8 z', fill: 'rgba(41,41,35,0.35)' })),
              ),
              edges.map(([from, to]) => {
                const a = pos.get(from)
                const b = pos.get(to)
                if (!a || !b) return null
                return h('line', {
                  key: `e-${from}-${to}`,
                  x1: a.x + 122,
                  y1: a.y + 18,
                  x2: b.x - 2,
                  y2: b.y + 18,
                  stroke: 'rgba(41,41,35,0.28)',
                  strokeWidth: 1.2,
                  markerEnd: 'url(#dsh-team-arrow)',
                })
              }),
              picked.map((task) => {
                const at = pos.get(task.taskId) ?? { x: 18, y: 18 }
                const label = String(task.bot ?? '').slice(0, 10)
                const shortId = String(task.taskId ?? '').replace(/^t-/, '').slice(0, 8)
                const status = String(task.status ?? '')
                return h(
                  'g',
                  { key: task.taskId, transform: `translate(${at.x},${at.y})` },
                  h('rect', { width: 122, height: 34, rx: 7, fill: '#FFFDF7', stroke: colorOf(status), strokeWidth: 1.2 }),
                  h('text', { x: 8, y: 14, fontSize: 9, fill: '#292923', fontFamily: 'inherit' }, `${label} ${shortId}`),
                  h('text', { x: 8, y: 26, fontSize: 8, fill: colorOf(status), fontFamily: 'inherit' }, status || 'queued'),
                )
              }),
            ),
        h('div', { style: { marginTop: 8, fontSize: 9.5, lineHeight: 1.5, color: p.faint } }, '箭头表示依赖：左边先跑，右边等它。验收门任务在上游通过后才放行。'),
      ),
    )
  }

  function Panel(props) {
    const skin = useSkin()
    const p = palette()
    const aurora = false
    // Live roster from the host; the demo list is only a first-paint fallback.
    const [revision, setRevision] = React.useState(0)
    const [boardOpen, setBoardOpen] = React.useState(false)
    const [graphOpen, setGraphOpen] = React.useState(false)
    const [mailboxBot, setMailboxBot] = React.useState(null)
    const [allTasks, setAllTasks] = React.useState([])
    const [boardFilter, setBoardFilter] = React.useState('all')

    // 主进程推来变更时自增，下面的数据源 effect 会因此重跑一次。
    React.useEffect(() => {
      const onChange = () => setRevision((value) => value + 1)
      window.addEventListener('dsh-team:changed', onChange)
      return () => window.removeEventListener('dsh-team:changed', onChange)
    }, [])

    const [live, setLive] = React.useState(null)
    const [userGroups, setUserGroups] = React.useState([])
    const [confirmGroup, setConfirmGroup] = React.useState(null)
    /** 正在确认彻底删除的成员。 */
    const [confirmRemove, setConfirmRemove] = React.useState(null)
    /** 正在展开设置的成员组：`{ id, name, key }`，内置组 id 为空串。 */
    const [settingsGroup, setSettingsGroup] = React.useState(null)
    const [noSessionHint, setNoSessionHint] = React.useState(null)
    React.useEffect(() => {
      ensureGlobalSheet()
      // 打不开成员页时由这里把原因说给用户。
      onMembersPaneFailed = (text) => setNotice(text)
      // 只报告当前用的是哪套皮肤，不改任何显示。
      let stored = null
      try {
        stored = globalThis.localStorage?.getItem('dsh-team:skin')
      } catch {
        stored = null
      }
      reportDiag({ event: 'skin', stored, resolved: 'classic', build: BUILD_STAMP })
    }, [])
    const [inlineEdit, setInlineEdit] = React.useState(null)
    /** 自带的审计员被删掉了——在它原来那个组的招募条右边给一个恢复键。 */
    const [removedBuiltins, setRemovedBuiltins] = React.useState([])
    const missingAuditor = live !== null && !live.some((member) => member.id === 'auditor')
    // 记着它当时在哪个组：空串 = 行动预备组；没记录就按行动预备组算。
    const auditorGroup = removedBuiltins.find((entry) => entry.id === 'auditor')?.group ?? ''
    const auditorRestoreKey = auditorGroup === '' ? 'reserve' : `g:${auditorGroup}`
    const restoreAuditor = async () => {
      setNotice('恢复中…')
      try {
        const response = await fetch('/dsh-team/builtin', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'restore', id: 'auditor' }),
        })
        const data = await response.json()
        if (!data.ok) {
          setNotice(data.error ?? '恢复失败')
          return
        }
        setRevision((value) => value + 1)
        setNotice('审计员已恢复')
      } catch (error) {
        setNotice(`恢复失败：${error?.message ?? error}`)
      }
    }
    /** 团队知识库编辑器开着没有。 */
    const [knowledgeOpen, setKnowledgeOpen] = React.useState(false)
    /** 使用说明弹窗。 */
    const [helpOpen, setHelpOpen] = React.useState(false)
    const [promoteBot, setPromoteBot] = React.useState(null)
    const [growthBot, setGrowthBot] = React.useState(null)
    const [recruitKey, setRecruitKey] = React.useState(null)
    const [recent, setRecent] = React.useState([])
    const [editing, setEditing] = React.useState(false)
    const [editorKey, setEditorKey] = React.useState(0)
    const sessionForRoster = resolveSessionId(props)
    React.useEffect(() => {
      let alive = true
      const tick = async () => {
        try {
          const response = await fetch(
            `/dsh-team/roster?sessionId=${encodeURIComponent(sessionForRoster)}`,
          )
          const data = await response.json()
          if (alive && Array.isArray(data?.members)) setLive(data.members)
          if (alive && Array.isArray(data?.groups)) setUserGroups(data.groups)
          // 自带 Bot 被删掉了、原本在哪个组：恢复键要出现在那个组的招募条右边。
          if (alive && Array.isArray(data?.removedBuiltins)) setRemovedBuiltins(data.removedBuiltins)
          // 两个实例同时用同一个目录会互相覆盖：只在第一次提示一次。
          if (alive && data?.instanceConflict && !conflictNoticed.current) {
            conflictNoticed.current = true
            setNotice(`另一个 DSH 实例（pid ${data.instanceConflict.pid}）也在用这个目录，两边会互相覆盖。`)
          }
        } catch {
          // Host route missing or offline: keep whatever is on screen.
        }
      }
      void tick()
      const timer = setInterval(tick, 2000)
      return () => {
        alive = false
        clearInterval(timer)
      }
    }, [sessionForRoster, revision])

    // 成本统计：每个 Bot 干了多少件、回了多少字。
    React.useEffect(() => {
      let alive = true
      const tick = async () => {
        try {
          const response = await fetch('/dsh-team/stats')
          const data = await response.json()
          if (alive && Array.isArray(data?.bots)) setStats(data.bots)
        } catch {
          // 统计失败不影响主列表。
        }
      }
      void tick()
      const timer = setInterval(tick, 10_000)
      return () => {
        alive = false
        clearInterval(timer)
      }
    }, [])

    // Recent tasks: the books behind the cards.
    React.useEffect(() => {
      let alive = true
      const tick = async () => {
        try {
          const response = await fetch(
            `/dsh-team/tasks?sessionId=${encodeURIComponent(sessionForRoster)}`,
          )
          const data = await response.json()
          if (alive && Array.isArray(data?.tasks)) {
            // chat 是 cancel 后的补问会话，不算正式任务；混在最近任务里只会挤占成员区。
            setRecent(data.tasks.filter((task) => task.status !== 'chat').slice(0, 5))
          }
        } catch {
          // Keep the previous list.
        }
      }
      void tick()
      const timer = setInterval(tick, 2000)
      return () => {
        alive = false
        clearInterval(timer)
      }
    }, [sessionForRoster])


    // 任务看板：打开时拉全量账本，并按状态筛。
    React.useEffect(() => {
      // 看板和依赖图都要全量账本；只开依赖图时也得拉，否则 allTasks 一直是空的。
      if (!boardOpen && !graphOpen) return undefined
      let alive = true
      const tick = async () => {
        try {
          const response = await fetch('/dsh-team/tasks?sessionId=unknown')
          const data = await response.json()
          if (alive && Array.isArray(data?.tasks)) setAllTasks(data.tasks)
        } catch {
          // 拉不到就保持旧列表
        }
      }
      void tick()
      const timer = setInterval(tick, 5000)
      return () => {
        alive = false
        clearInterval(timer)
      }
    }, [boardOpen, graphOpen, revision])

    const members = Array.isArray(props?.members)
      ? props.members
      : Array.isArray(live) ? live : DEMO_MEMBERS
    const groups = buildGroupList(members, userGroups)
    const [collapsed, setCollapsed] = React.useState({})
    /** 每点一次「新增成员组」加一：让编辑面板滚到分组那块并聚焦输入框。 */
    const [groupFocus, setGroupFocus] = React.useState(0)
    const [notice, setNotice] = React.useState('')
    /** 「另一个实例也在用这个目录」只提示一次。 */
    const conflictNoticed = React.useRef?.(false) ?? { current: false }
    const [detail, setDetail] = React.useState(null)
    const [stats, setStats] = React.useState([])
    const [retrying, setRetrying] = React.useState(false)

    /**
     * 点头像 / 带参数进来 / dsh-avatar-frame 里点 ID：直接展开这个成员的行内设置。
     * 团队面板（新增成员组）不管成员，别把人送到错误的入口。
     */
    React.useEffect(() => {
      const openInlineFor = (botId) => {
        if (typeof botId !== 'string' || botId === '') return
        pendingEditorBot = null
        setEditing(false)
        setInlineEdit(botId)
      }
      openInlineFor(props?.params?.bot ?? pendingEditorBot)
      const onOpen = (event) => openInlineFor(event?.detail?.botId)
      window.addEventListener('dsh-team:open-bot-ui', onOpen)
      return () => window.removeEventListener('dsh-team:open-bot-ui', onOpen)
    }, [props?.params?.bot])

    /**
     * 打开某个 Bot 的会话：先试侧栏的 subagentchat 资源，再试主视图的
     * openSession；都不可用时把原因写出来，而不是静默失败。
     */
    React.useEffect(() => {
      if (noSessionHint === null) return undefined
      const timer = setTimeout(() => setNoSessionHint(null), 6000)
      timer.unref?.()
      return () => clearTimeout(timer)
    }, [noSessionHint])

    const openChat = async (member) => {
      let sessionId = member?.sessionId
      // 刚开出来的会话，名册还没刷新，父会话 id 只能从开会话的返回值里拿。
      let openedParent = ''
      // 宿主连身份一起给：开页前写进头像映射，第一帧就是 Bot 自己。
      let openedIdentity
      if (!sessionId) {
        // 还没有会话：先开一个单聊会话，再把它打开。
        setNoSessionHint(member?.id ?? null)
        setNotice(`正在给 ${member?.name || member?.id} 开会话…`)
        try {
          const response = await fetch('/dsh-team/open', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bot: member?.id, sessionId: sessionForRoster }),
          })
          const data = await response.json()
          if (!data?.ok) {
            setNotice(data?.error ?? '开会话失败')
            setNoSessionHint(null)
            return
          }
          sessionId = data.sessionId
          openedParent = String(data.parentSessionId ?? '')
          openedIdentity = data.identity
          setNotice('')
        } catch (error) {
          setNotice(`开会话失败：${error?.message ?? error}`)
          setNoSessionHint(null)
          return
        }
      }
      setNoSessionHint(null)
      const service = (name) => {
        try {
          if (typeof host?.get === 'function') {
            const found = host.get(name)
            if (found !== undefined) return found
          }
        } catch {
          // 落到属性访问
        }
        try {
          return host?.[name]
        } catch {
          return undefined
        }
      }

      const sidebar = service('sidebarRight')
      if (!sidebar || typeof sidebar.openResource !== 'function') {
        setNotice('这个版本没有右侧栏接口，打不开会话')
        return
      }

      const parent = member?.parentSessionId ?? openedParent
      const address = `dsh-resource://subagentchat/session/${encodeURIComponent(sessionId)}`
        + `?parent=${encodeURIComponent(parent ?? '')}&mode=unknown`

      // 右侧栏最多两栏：分一栏给子会话，成员列表留在原来那一栏。
      let paneId
      try {
        paneId = sidebar.split?.()
        reportDiag({ event: 'split', ok: paneId !== undefined, paneId: paneId ?? null })
      } catch (error) {
        reportDiag({ event: 'split-failed', error: String(error?.message ?? error) })
      }

      // 头像/ID 的第一帧：开页之前先把这一条映射写进去，别让它先顶着主会话的脸。
      // 映射平时靠 10 秒轮询刷新，等那一轮就是好几秒的错头像。
      stampTeamIdentity(sessionId, openedIdentity)

      // 子会话刚建好时，客户端的会话表还没跟上，openResource 会以
      // 「invalid chat resource address」拒一次（父会话 id 为空也会这样）。
      // 给它几次机会，别让用户点第二次。
      const target = paneId === undefined
        ? { kind: 'subagentchat', preferNewPane: true }
        : { kind: 'subagentchat', paneId }
      let openError
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          sidebar.openResource(address, target)
          openError = undefined
          break
        } catch (error) {
          openError = error
          reportDiag({ event: 'open-retry', attempt, error: String(error?.message ?? error) })
          await new Promise((resolve) => { setTimeout(resolve, 200 + attempt * 150) })
        }
      }
      if (openError) {
        setNotice(`打开会话失败：${openError?.message ?? openError}`)
        return
      }
      setNotice('')
      // 开页之后跟宿主对一次全量映射：新会话、头像版本、名字都会补齐。
      void publishTeamIdentity(true)

      // 有时候侧栏没真的把会话开出来（分栏满了、或者资源被引导页顶掉）：
      // 等一下检查，不行就退回主视图打开。
      setTimeout(() => {
        try {
          const rows = typeof sidebar.openTabs?.getSnapshot === 'function' ? sidebar.openTabs.getSnapshot() : []
          const opened = Array.isArray(rows) && rows.some((row) => row.kind === 'subagentchat' && row.sessionId === sessionId)
          if (opened) return
          const workspace = service('uiWorkspace')
          if (workspace && typeof workspace.openSession === 'function') {
            workspace.openSession(address)
            setNotice('')
            reportDiag({ event: 'open-fallback', sessionId })
          } else {
            setNotice('侧栏没有打开这个会话，换一个标签再试一次')
          }
        } catch {
          // 检查失败就当它已经开了
        }
      }, 700)

      // 关掉子会话后，那一栏会自动补一张「开始」引导页，得多点一次才干净。
      // 这里盯着标签清单：会话标签消失了，就把同一会话里剩下的引导页收掉。
      watchClosedPane(sidebar, props?.sessionId ?? sessionId)
    }

    /**
     * 会话标签被关掉后清理它留下的引导页。
     * @param sidebar - 右侧栏控制器。
     * @param forSession - 只处理这个会话的标签。
     */
    function watchClosedPane(sidebar, forSession) {
      try {
        const source = sidebar?.openTabs
        if (!source || typeof source.getSnapshot !== 'function') return
        const read = () => {
          try {
            const rows = source.getSnapshot()
            return Array.isArray(rows) ? rows.filter((row) => row.sessionId === forSession) : []
          } catch {
            return []
          }
        }
        let sawChat = read().some((row) => row.kind === 'subagentchat')
        let ticks = 0
        const timer = setInterval(() => {
          ticks += 1
          const rows = read()
          const hasChat = rows.some((row) => row.kind === 'subagentchat')
          if (hasChat) {
            sawChat = true
          } else if (sawChat) {
            const guides = rows.filter((row) => row.kind === 'guide')
            for (const guide of guides) {
              try {
                sidebar.close?.(guide.tabId)
                reportDiag({ event: 'guide-cleaned', tabId: guide.tabId })
              } catch (error) {
                reportDiag({ event: 'guide-clean-failed', error: String(error?.message ?? error) })
              }
            }
            clearInterval(timer)
            return
          }
          if (ticks > 900) clearInterval(timer)
        }, 800)
        timer.unref?.()
      } catch {
        // 清理只是顺手，失败不影响使用。
      }
    }

    const header = h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto' } },
      h(
        'span',
        {
          style: {
            fontWeight: 600,
            letterSpacing: aurora ? '0.14em' : undefined,
            // 标题比正文高一档，一眼能找到这块面板。
            fontSize: aurora ? 15 : 16,
            color: p.text,
          },
        },
        '成员',
      ),
      h(
        'span',
        {
          style: {
            fontSize: 10,
            color: p.faint,
            border: `1px solid ${p.line}`,
            borderRadius: aurora ? 2 : 8,
            padding: '0 5px',
            lineHeight: '14px',
          },
        },
        String(members.length),
      ),
      aurora
        ? h('span', {
            'aria-hidden': true,
            style: { width: 24, height: 1, background: p.accent, marginLeft: 2 },
          })
        : null,
      h(
        'div',
        { style: { marginLeft: 'auto', display: 'flex', gap: aurora ? 4 : 2 } },
        h(HeaderButton, {
          key: 'help',
          label: '使用说明',
          text: '使用说明',
          icon: h(BookIcon, { size: 13 }),
          action: '使用说明',
          onActivate: () => setHelpOpen(true),
        }),
        h(HeaderButton, {
          key: 'knowledge',
          label: '团队知识库',
          text: '团队知识',
          icon: h(PenIcon, { size: 13 }),
          action: '团队知识库',
          onActivate: () => setKnowledgeOpen(true),
        }),
        h(HeaderButton, {
          key: 'group',
          label: '新增成员组',
          text: '新增成员组',
          icon: h(HammerIcon, { size: 13 }),
          action: '新增成员组',
          onActivate: () => {
            // 再点一下收起；展开时直接落到「团队」页的分组那一块。
            if (editing) {
              setEditing(false)
              return
            }
            setEditorKey((key) => key + 1)
            setEditing(true)
            setGroupFocus((n) => n + 1)
          },
        }),
        h(HeaderButton, {
          key: 'skin',
          label: '皮肤：默认',
          glyph: '◐',
          action: '切换皮肤',
          onActivate: () => pinSkinChoice(),
        }),
      ),
    )

    // 孤星的标志：标题下面一条三色线——橙、橄榄、砖红，长度递减收尾。
    const rule = aurora
      ? h(
          'div',
          {
            'aria-hidden': true,
            style: { flex: '0 0 auto', display: 'flex', gap: 3, margin: '4px 0 2px' },
          },
          h('span', { key: 'o', style: { width: 46, height: 2, background: (p.tri ?? [])[0] ?? p.accent } }),
          h('span', { key: 'v', style: { width: 26, height: 2, background: (p.tri ?? [])[1] ?? p.accentSoft } }),
          h('span', { key: 'r', style: { width: 12, height: 2, background: (p.tri ?? [])[2] ?? p.third } }),
          h('span', { key: 't', style: { flex: '1 1 auto', height: 1, background: p.line, marginTop: 1 } }),
        )
      : null

    const body = editing
      ? h(BotEditor, {
          key: editorKey,
          focusGroup: groupFocus,
          sessionId: sessionForRoster,
          onClose: () => setEditing(false),
          onSaved: () => {},
        })
      : members.length === 0
      ? h(
          'div',
          {
            style: {
              flex: '1 1 auto',
              display: 'grid',
              placeItems: 'center',
              color: p.faint,
              fontSize: 12,
            },
          },
          '还没有成员',
        )
      : h(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: aurora ? 12 : 10,
              minHeight: 0,
              overflowY: 'auto',
            },
          },
          groups.map((group) => h(
            'div',
            { key: group.key, style: { display: 'flex', flexDirection: 'column', gap: aurora ? 5 : 6 } },
            h(
              'div',
              {
                role: 'button',
                tabIndex: 0,
                title: collapsed[group.key] ? '展开' : '收起',
                onClick: () => setCollapsed({ ...collapsed, [group.key]: !collapsed[group.key] }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setCollapsed({ ...collapsed, [group.key]: !collapsed[group.key] })
                  }
                },
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  height: 26,
                  cursor: 'pointer',
                  userSelect: 'none',
                  background: '#313131',
                  overflow: 'hidden',
                },
              },
              // 左边三条色带：蓝绿、金、砖红，硬边渐变，中间不留缝。
              h("span", {
                "aria-hidden": true,
                style: {
                  width: 12,
                  height: "100%",
                  flex: "0 0 auto",
                  background: "linear-gradient(to right, #86C1AF 0 4px, #EBA93F 4px 8px, #992C27 8px 12px)",
                },
              }),
              h('span', {
                'aria-hidden': true,
                style: {
                  fontSize: 14,
                  lineHeight: '14px',
                  color: '#F2F2F2',
                  opacity: 0.82,
                  marginLeft: 8,
                  marginRight: 5,
                  width: 10,
                  textAlign: 'center',
                },
              }, collapsed[group.key] ? '▸' : '▾'),
              h(
                'span',
                {
                  style: {
                    color: '#F2F2F2',
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  },
                },
                `${group.meta.label} · ${group.items.length}`,
              ),
              h('span', { 'aria-hidden': true, style: { flex: '1 1 auto' } }),
              // 每个成员组卡片最右边一个锤子：点它改的这个组（改名 / 删除）。
              h(
                'button',
                {
                  type: 'button',
                  title: `设置「${group.meta.label}」`,
                  'aria-label': `设置分组 ${group.meta.label}`,
                  onClick: (event) => {
                    event.stopPropagation()
                    // 点一下在这个组卡片下面展开团队设置，再点一下收起。
                    const entry = { id: group.id ?? '', name: group.meta.label, key: group.key }
                    setSettingsGroup((current) => (current?.key === group.key ? null : entry))
                  },
                  style: {
                    flex: '0 0 auto',
                    width: 22,
                    height: 22,
                    padding: 0,
                    marginRight: 4,
                    display: 'grid',
                    placeItems: 'center',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                  },
                },
                h(HammerIcon, { size: 13 }),
              ),
            ),
            // 点组卡片的锤子：团队设置直接在这个组下面展开，不弹窗。
            settingsGroup?.key === group.key
              ? h(BotEditor, {
                  key: `group-${group.key}`,
                  inline: true,
                  group: { id: settingsGroup.id, name: settingsGroup.name },
                  sessionId: sessionForRoster,
                  focusGroup: 0,
                  onClose: () => setSettingsGroup(null),
                  onSaved: () => setRevision((value) => value + 1),
                  onDeleteGroup: (target) => {
                    setSettingsGroup(null)
                    setConfirmGroup({ id: target.id, name: target.name })
                  },
                })
              : null,
            collapsed[group.key]
              ? null
              : group.key === 'action' && group.items.length === 0
              ? h(
                  'div',
                  {
                    style: {
                      fontSize: 10,
                      color: p.faint,
                      padding: '4px 2px 2px',
                      lineHeight: 1.5,
                    },
                  },
                  '还没派过活。派给某个 Bot 之后，它会出现在这里。',
                )
              : group.items.map((member) => h(
                  React.Fragment,
                  { key: member.id },
                  h(PanelMemberCard, {
                    member,
                    hint: noSessionHint === member.id,
                    onOpen: (target) => openChat(target),
                    onOpenSession: openChat,
                    onOpenMailbox: (target) => setMailboxBot(target),
                    onSettings: (target) => setInlineEdit((current) => (current === target?.id ? null : target?.id)),
                    onPromote: (target) => setPromoteBot(target),
                    onArchive: (target) => setGrowthBot(target),
                    onRemove: (target) => setConfirmRemove(target),
                  }),
                  inlineEdit === member.id
                    ? h(MemberSettingsInline, {
                        member,
                        onDone: () => {
                          setInlineEdit(null)
                          setRevision((value) => value + 1)
                        },
                      })
                    : null,
                )),
            // 行动组是自动分配的，不给招募入口；其余组都能往里招人。
            collapsed[group.key] || group.key === 'action'
              ? null
              : h(
                  'div',
                  { style: { display: 'flex', alignItems: 'stretch', gap: 4 } },
                  h(
                    'div',
                    { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0 } },
                    h(RecruitBar, {
                      open: recruitKey === group.key,
                      onToggle: () => setRecruitKey((current) => (current === group.key ? null : group.key)),
                    }),
                    recruitKey === group.key
                      ? h(RecruitInline, {
                          groupId: group.id ?? '',
                          groupName: group.meta.label,
                          onDone: (bot) => {
                            setRecruitKey(null)
                            if (bot) setRevision((value) => value + 1)
                          },
                        })
                      : null,
                  ),
                  // 自带的审计员被删了：在它原来那个组的招募条右边给一个恢复键。
                  group.key === auditorRestoreKey && missingAuditor
                    ? h(
                        'button',
                        {
                          type: 'button',
                          title: '把自带的审计员恢复回来',
                          onClick: restoreAuditor,
                          style: {
                            flex: '0 0 auto',
                            padding: '0 8px',
                            height: 20,
                            fontSize: 10,
                            color: '#F4F1E4',
                            background: '#6A9842',
                            border: '1px solid #4E7231',
                            cursor: 'pointer',
                            whiteSpace: 'nowrap',
                          },
                        },
                        '恢复审计员',
                      )
                    : null,
                ),
          )),
        )

    /**
     * 一件任务的详情：任务单、产物目录、验收记录，外加一个重试按钮。
     */
    const detailView = detail
      ? h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11, color: p.dim } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('span', { style: { fontWeight: 600, fontSize: 12, color: p.text } }, detail.taskId),
            h('span', { style: { color: p.faint } }, `${detail.bot} · ${detail.status}`),
            h('span', { style: { marginLeft: 'auto' } }),
            h(
              'button',
              {
                type: 'button',
                disabled: retrying,
                onClick: async () => {
                  setRetrying(true)
                  setNotice('重试中…')
                  try {
                    const response = await fetch('/dsh-team/retry', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ taskId: detail.taskId }),
                    })
                    const data = await response.json()
                    setNotice(data?.ok === false ? (data.error ?? '重试失败') : `已重派：${data.taskId ?? ''}`)
                  } catch (error) {
                    setNotice(`重试失败：${error?.message ?? error}`)
                  } finally {
                    setRetrying(false)
                  }
                },
                style: {
                  padding: '3px 8px',
                  fontSize: 11,
                  color: p.text,
                  background: 'transparent',
                  border: `1px solid ${p.line}`,
                  borderRadius: aurora ? 2 : 4,
                  cursor: retrying ? 'wait' : 'pointer',
                },
              },
              '按原单重派',
            ),
            h(
              'button',
              {
                type: 'button',
                title: '把任务单、验收意见和产物清单写成一份 Markdown',
                onClick: async () => {
                  setNotice('导出中…')
                  try {
                    const response = await fetch('/dsh-team/task-export', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ taskId: detail.taskId }),
                    })
                    const data = await response.json()
                    setNotice(data?.ok ? `已导出：${data.path}` : (data.error ?? '导出失败'))
                  } catch (error) {
                    setNotice(`导出失败：${error?.message ?? error}`)
                  }
                },
                style: {
                  padding: '3px 8px',
                  fontSize: 11,
                  color: p.text,
                  background: 'transparent',
                  border: `1px solid ${p.line}`,
                  borderRadius: aurora ? 2 : 4,
                  cursor: 'pointer',
                },
              },
              '导出记录',
            ),
            detail.doneAt
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    onClick: async () => {
                      setNotice('中止中…')
                      try {
                        const response = await fetch('/dsh-team/cancel', {
                          method: 'POST',
                          headers: { 'content-type': 'application/json' },
                          body: JSON.stringify({ taskId: detail.taskId }),
                        })
                        const data = await response.json()
                        setNotice(data?.ok ? '已中止' : (data.error ?? '中止失败'))
                        setDetail({ ...detail, status: 'cancelled', doneAt: Date.now() })
                      } catch (error) {
                        setNotice(`中止失败：${error?.message ?? error}`)
                      }
                    },
                    style: {
                      padding: '3px 8px',
                      fontSize: 11,
                      color: p.danger,
                      background: 'transparent',
                      border: `1px solid ${p.danger}`,
                      borderRadius: aurora ? 2 : 4,
                      cursor: 'pointer',
                    },
                  },
                  '中止',
                ),
            h(
              'button',
              {
                type: 'button',
                onClick: () => setDetail(null),
                style: {
                  padding: '3px 8px',
                  fontSize: 11,
                  color: p.text,
                  background: 'transparent',
                  border: `1px solid ${p.line}`,
                  borderRadius: aurora ? 2 : 4,
                  cursor: 'pointer',
                },
              },
              '返回',
            ),
          ),
          detail.brief?.task ? h('div', null, `任务单：${detail.brief.task}`) : null,
          detail.dependsOn?.length ? h('div', null, `依赖${detail.dependsOnMode === 'accepted' ? '（验收后放行）' : ''}：${detail.dependsOn.join('、')}`) : null,
          detail.blockedBy ? h('div', { style: { color: p.warn } }, `阻塞：${detail.blockedBy}`) : null,
          h(TaskMailThread, { taskId: detail.taskId, p }),
          detail.brief?.accept ? h('div', null, `验收：${detail.brief.accept}`) : null,
          detail.brief?.redlines ? h('div', null, `红线：${detail.brief.redlines}`) : null,
          detail.cwd ? h('div', { style: { wordBreak: 'break-all' } }, `目录：${detail.cwd}`) : null,
          detail.tokens?.total
            ? h(
                'div',
                null,
                `token：${formatTokens(detail.tokens.total)}（输入 ${formatTokens(detail.tokens.input)} / 输出 ${formatTokens(detail.tokens.output)}${
                  detail.tokens.cacheRead ? ` / 缓存读 ${formatTokens(detail.tokens.cacheRead)}` : ''
                }）`,
              )
            : null,
          detail.startedAt
            ? h(
                'div',
                null,
                `用时：${formatDuration(((detail.doneAt ?? Date.now()) - detail.startedAt) / 1000)}${
                  detail.tokens?.total
                    ? ` · ${formatTokens(Math.round(detail.tokens.total / Math.max(1 / 60, ((detail.doneAt ?? Date.now()) - detail.startedAt) / 60000)))} tok/分钟`
                    : ''
                }`,
              )
            : null,
          detail.model ? h('div', null, `模型：${detail.model}`) : null,
          detail.note ? h('div', null, `验收意见：${detail.note}`) : null,
          detail.userSignal
            ? h('div', null, `用户反馈：${USER_SIGNAL_LABELS[detail.userSignal] ?? detail.userSignal}${detail.userNote ? `「${detail.userNote}」` : ''}`)
            : null,
          detail.evidence ? h('div', null, `依据：${detail.evidence}`) : null,
          detail.output ? h('div', { style: { whiteSpace: 'pre-wrap' } }, detail.output) : null,
        )
      : null

    const boardRows = boardOpen
      ? (boardFilter === 'all' ? allTasks : allTasks.filter((task) => task.status === boardFilter)).slice(0, 60)
      : recent
    const taskHeader = h(
      'div',
      {
        style: {
          display: 'flex',
          gap: 6,
          alignItems: 'baseline',
          color: p.faint,
          letterSpacing: aurora ? '0.14em' : undefined,
        },
      },
      boardOpen ? '全部任务' : '最近任务',
      recent.some((task) => task.status === 'ready')
        ? h('span', { style: { color: p.warn } }, `待验收 ${recent.filter((task) => task.status === 'ready').length}`)
        : null,
      recent.some((task) => task.stuck)
        ? h('span', { style: { color: p.danger } }, `卡住 ${recent.filter((task) => task.stuck).length}`)
        : null,
      h(
        'button',
        {
          type: 'button',
          onClick: () => setBoardOpen((open) => !open),
          style: {
            marginLeft: 'auto',
            padding: '1px 6px',
            fontSize: 10,
            color: p.dim,
            background: 'transparent',
            border: `1px solid ${p.line}`,
            borderRadius: aurora ? 2 : 4,
            cursor: 'pointer',
          },
        },
        boardOpen ? '只看最近' : '看全部',
      ),
      h(
        'button',
        {
          type: 'button',
          title: '查看任务依赖关系',
          onClick: () => setGraphOpen(true),
          style: {
            padding: '1px 6px',
            fontSize: 10,
            color: p.dim,
            background: 'transparent',
            border: `1px solid ${p.line}`,
            borderRadius: aurora ? 2 : 4,
            cursor: 'pointer',
          },
        },
        '依赖图',
      ),
      boardOpen
        ? h(
            'button',
            {
              type: 'button',
              title: '把已结束、待验收的任务从账本里删掉',
              onClick: async () => {
                try {
                  const response = await fetch('/dsh-team/tasks-clean', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ status: 'ready' }),
                  })
                  const data = await response.json()
                  setNotice(data?.ok ? `清掉 ${data.removed.length} 条待验收` : (data.error ?? '清理失败'))
                  setRevision((value) => value + 1)
                } catch (error) {
                  setNotice(`清理失败：${error?.message ?? error}`)
                }
              },
              style: {
                padding: '1px 6px',
                fontSize: 10,
                color: p.danger,
                background: 'transparent',
                border: `1px solid ${p.danger}`,
                borderRadius: aurora ? 2 : 4,
                cursor: 'pointer',
              },
            },
            '清理待验收',
          )
        : null,
    )
    const filterChips = boardOpen
      ? h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
          ['all', 'running', 'ready', 'accepted', 'rejected', 'cancelled', 'chat', 'failed', 'timeout'].map((key) => h(
            'button',
            {
              key,
              type: 'button',
              onClick: () => setBoardFilter(key),
              style: {
                padding: '1px 6px',
                fontSize: 10,
                color: boardFilter === key ? p.text : p.faint,
                background: 'transparent',
                border: `1px solid ${boardFilter === key ? p.accent : p.line}`,
                borderRadius: aurora ? 2 : 4,
                cursor: 'pointer',
              },
            },
            key === 'all' ? '全部' : key,
          )),
        )
      : null

    const taskSection = detail
      ? detailView
      : editing || boardRows.length === 0
        ? null
        : h(
            'div',
            {
              style: {
                // 成员少的时候让最近任务把剩下的高度吃满；成员多时仍只占
                // 一块，给上面的名单留空间。原来的 18vh 会在这两种情况下
                // 都留下一条空白。
                flex: members.length <= 3 ? '1 1 auto' : '0 0 auto',
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
                maxHeight: members.length <= 3 ? 'none' : '18vh',
                overflowY: 'auto',
                borderTop: `1px solid ${p.line}`,
                paddingTop: 8,
                fontSize: 11,
                color: p.dim,
              },
            },
            taskHeader,
            filterChips,
            boardRows.map((task) => {
              const endAt = task.doneAt ?? Date.now()
              const durationSec = task.startedAt ? (endAt - task.startedAt) / 1000 : 0
              const member = members.find((item) => item?.id === task.bot)
              const botName = member?.name ?? task.bot
              const botRole = member?.role ?? ''
              const output = String(task.output ?? '').trim()
              return h(
                'div',
                {
                  key: task.taskId,
                  role: 'button',
                  tabIndex: 0,
                  title: '看这一件的详情',
                  onClick: () => setDetail(task),
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    padding: '4px 0',
                    cursor: 'pointer',
                  },
                },
                h(
                  'div',
                  { style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
                  h('span', {
                    style: {
                      flex: '0 0 auto',
                      color: task.status === 'accepted' ? p.good
                        : task.status === 'chat' ? p.accentSoft
                        : task.status === 'rejected' ? p.danger
                        : task.status === 'ready' ? p.accent
                        : task.status === 'cancelled' ? p.faint
                        : p.warn,
                    },
                  }, task.status),
                  h('span', { style: { color: p.text, fontWeight: 600 } }, botName),
                  h('span', { style: { color: p.dim } }, `@${task.bot}`),
                  botRole ? h('span', { style: { color: p.faint } }, botRole) : null,
                  task.continuesFrom ? h('span', { style: { color: p.accentSoft }, title: `原会话继续：${task.continuesFrom}` }, '续') : null,
                  task.dependsOn?.length
                    ? h('span', {
                        style: { color: task.status === 'blocked' ? p.danger : p.faint },
                        title: task.blockedBy || `依赖：${task.dependsOn.join('、')}`,
                      }, task.status === 'blocked' ? '依赖未满足' : task.status === 'queued' ? `${task.dependsOnMode === 'accepted' ? '等验收' : '等'} ${task.dependsOn.join('、')}` : `依赖 ${task.dependsOn.join('、')}`)
                    : null,
                  task.startedAt ? h('span', { style: { color: p.faint } }, formatDuration(durationSec)) : null,
                  task.tokens?.total ? h('span', { style: { color: p.faint } }, `${formatTokens(task.tokens.total)} tok`) : null,
                  h('span', { style: { color: p.faint, marginLeft: 'auto' } }, task.taskId),
                  task.stuck ? h('span', { style: { color: p.warn } }, ' 卡住') : null,
                ),
                output
                  ? h(
                      'div',
                      {
                        title: output,
                        style: {
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          color: p.dim,
                          paddingLeft: 10,
                        },
                      },
                      output,
                    )
                  : null,
              )
            }),
          )

    // 晋升：整个过程都在框里走，面板这边只负责发请求、把结果交回去。
    const promoteDialog = promoteBot
      ? h(PromoteDialog, {
          member: promoteBot,
          onCancel: () => {
            setPromoteBot(null)
            setRevision((value) => value + 1)
          },
          onRun: async (member) => {
            const response = await fetch('/dsh-team/promote', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ bot: member?.id, sessionId: sessionForRoster }),
            })
            const data = await response.json()
            if (!data?.ok) return { ok: false, error: data?.error ?? '晋升失败' }
            setRevision((value) => value + 1)
            return {
              ok: true,
              label: data?.label ?? rankLabel((Number(member?.rank) || 0) + 1),
              rank: Number(data?.rank) || (Number(member?.rank) || 0) + 1,
              speech: typeof data?.speech === 'string' ? data.speech : '',
              speechError: data?.speechError ?? '',
              // 固定文案：面板要把动效撑满 3 秒。
              fixed: data?.fixed === true,
            }
          },
        })
      : null

    // 成长档案（只读）。
    const growthDialog = growthBot
      ? h(GrowthDialog, {
          member: growthBot,
          onClose: () => setGrowthBot(null),
        })
      : null

    const confirmDialog = confirmGroup
      ? h(ConfirmGroupDialog, {
          group: confirmGroup,
          onCancel: () => setConfirmGroup(null),
          onConfirm: async (target) => {
            setConfirmGroup(null)
            try {
              const response = await fetch('/dsh-team/groups', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'delete', id: target.id }),
              })
              const data = await response.json()
              if (!data.ok) {
                setNotice(data.error ?? '删除失败')
                return
              }
              setUserGroups(data.groups)
              setRevision((value) => value + 1)
              setNotice(`已删除分组：${target.name}`)
            } catch (error) {
              setNotice(`删除失败：${error?.message ?? error}`)
            }
          },
        })
      : null

    // 彻底删除：和删分组同一张确认卡，确认后 DELETE（JSON + 整个目录一起删）。
    const removeDialog = confirmRemove
      ? h(ConfirmRemoveDialog, {
          member: confirmRemove,
          onCancel: () => setConfirmRemove(null),
          onConfirm: async (target) => {
            setConfirmRemove(null)
            try {
              const response = await fetch(`/dsh-team/bots?id=${encodeURIComponent(target.id)}`, { method: 'DELETE' })
              const data = await response.json()
              if (!data.ok) {
                setNotice(data.error ?? '删除失败')
                return
              }
              setRevision((value) => value + 1)
              setNotice(`已彻底删除：${target.name || target.id}`)
            } catch (error) {
              setNotice(`删除失败：${error?.message ?? error}`)
            }
          },
        })
      : null

    return h(
      'div',
      {
        'data-dsh-team-members': '',
        'data-dsh-team-skin': skin,
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: aurora ? 10 : 8,
          height: '100%',
          minHeight: 0,
          boxSizing: 'border-box',
          padding: aurora ? '12px 12px 14px' : '8px 10px 12px',
          fontSize: 13,
          lineHeight: 1.4,
          color: p.text,
          background: p.panel ?? (aurora ? p.surface : 'transparent'),
          border: aurora ? `1px solid ${p.line}` : 'none',
        },
      },
      header,
      rule,
      SELF_CHECK.checked && SELF_CHECK.missing.length > 0
        ? h('div', {
            style: { flex: '0 0 auto', padding: '4px 8px', fontSize: 10, lineHeight: 1.5, color: p.danger, borderBottom: `1px solid ${p.line}` },
          }, `当前 DSH 版本缺少：${SELF_CHECK.missing.join('、')}；相关功能（右栏、成员面板）会不可用，可能有版本不匹配。`)
        : null,
      body,
      notice
        ? h('div', {
            key: 'notice',
            style: { flex: '0 0 auto', fontSize: 11, color: p.warn, lineHeight: 1.4 },
          }, notice)
        : null,
      stats.length > 0
        ? h(
            'div',
            {
              style: {
                flex: '0 0 auto',
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                fontSize: 10,
                color: p.faint,
                borderTop: `1px solid ${p.line}`,
                paddingTop: 6,
              },
            },
            stats.slice(0, 4).map((row) => h(
              'span',
              { key: row.bot },
              `${row.bot} ${row.tasks} 件${row.tokens ? ` · ${formatTokens(row.tokens)} tok` : ''}`,
            )),
          )
        : null,
      taskSection,
      confirmDialog,
      removeDialog,
      helpOpen ? h(QuickstartDialog, { onClose: () => setHelpOpen(false) }) : null,
      knowledgeOpen
        ? h(TeamKnowledgeDialog, { onClose: () => setKnowledgeOpen(false), onSaved: () => setRevision((value) => value + 1) })
        : null,
      promoteDialog,
      growthDialog,
      mailboxBot ? h(MailboxDialog, { bot: mailboxBot, p, onClose: () => setMailboxBot(null) }) : null,
      graphOpen ? h(TaskGraphDialog, { tasks: allTasks, onClose: () => setGraphOpen(false), p }) : null,
    )
  }

  /**
   * 开始页（右栏引导页）里的「成员」入口卡。
   *
   * 默认那张是「图标 + 标题」的通用卡；这里换成和晋升 / 删除弹窗同一套的
   * 莱茵样式：深色外框、左边三色条、绿底奶油字，右上一个方框箭头。
   * 点它照旧打开成员页。只换这一张卡，不动面板正文。
   * @param props - 槽位下发的 `{ entryId, title, description, tab }`。
   */
  function MembersGuideCard(props) {
    if (props?.entryId !== 'members') return null
    const open = () => {
      openMembersPane()
      // 指南页不主动关的话会留在后面挡着，能关就关。
      try {
        props?.tab?.actions?.close?.()
        props?.hooks?.tabInfo?.actions?.close?.()
      } catch {
        // 关不掉也不影响已经打开的成员页。
      }
    }
    return h(
      'button',
      {
        type: 'button',
        'aria-label': '打开成员',
        onClick: open,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          width: '100%',
          minHeight: 44,
          padding: 0,
          margin: 0,
          // 和消息气泡同一套：米白底、浅描边、圆角。
          border: '1px solid #E4DCC9',
          borderRadius: 20,
          background: '#F6F1E5',
          cursor: 'pointer',
          textAlign: 'left',
          overflow: 'hidden',
        },
      },
      ['#86C1AF', '#EBA93F', '#992C27'].map((color, index) => h('span', {
        key: index,
        'aria-hidden': true,
        style: { width: 2, alignSelf: 'stretch', flex: '0 0 auto', background: color },
      })),
      h(
        'span',
        { style: { display: 'flex', flexDirection: 'column', gap: 1, padding: '7px 10px', minWidth: 0 } },
        h(
          'span',
          { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, letterSpacing: '0.18em', color: 'rgba(41,41,35,0.55)' } },
          h('span', null, 'RHINE LAB'),
          h('span', { style: { color: '#B07A2A' } }, 'MEMBERS'),
        ),
        h('span', { style: { fontSize: 13, fontWeight: 700, color: '#292923', lineHeight: 1.4 } }, props?.title || '成员'),
      ),
      h(
        'span',
        {
          'aria-hidden': true,
          style: {
            marginLeft: 'auto',
            marginRight: 10,
            width: 16,
            height: 16,
            flex: '0 0 auto',
            display: 'grid',
            placeItems: 'center',
            border: '1px solid rgba(41,41,35,0.35)',
            color: '#292923',
            fontSize: 11,
            lineHeight: 1,
          },
        },
        '›',
      ),
    )
  }

  /**
   * 把 Panel 挂成右栏 tab。需要 ctx 上有 `sidebarRightTabs`（类型注册表）与
   * `slots`（正文槽位）两个服务；接进 client.js 时记得把 `sidebarRightTabs`
   * 加进插件的 inject 列表。
   * @param ctx - 客户端插件上下文。
   * @returns 卸载函数；调用后撤掉本次注册。
   */
  function register(ctx) {
    if (!ctx?.slots || !ctx?.sidebarRightTabs) {
      console.warn('[dsh-team] 成员面板：缺少 slots / sidebarRightTabs 服务，未注册')
      return () => {}
    }

    // 第一阶段：类型。纯静态声明：id 唯一、kind 是 openTab 的名字、title 是 chip 文案。
    const definition = {
      id: MEMBERS_TAB_ID,
      kind: MEMBERS_TAB_KIND,
      priority: 'extension',
      title: () => '成员',
      // 引导页入口卡片：不注册自定义卡片时用默认图标 + 标题按钮。
      guide: [
        {
          id: 'members',
          order: 20,
          title: () => '成员',
          description: () => '查看小队成员与手头工作',
        },
      ],
    }

    const disposers = []
    const track = (run, label) => {
      // ctx.effect 负责随插件卸载自动清理；没有它时（离屏自检）手动收集。
      // 单条注册失败只记日志：不能因为一个槽位被占就带崩整次安装。
      try {
        const dispose = typeof ctx.effect === 'function' ? ctx.effect(run, label) : run()
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        reportDiag({ event: 'slot-register-failed', where: label, build: BUILD_STAMP, error: String(error?.message ?? error) })
      }
    }

    track(() => ctx.sidebarRightTabs.register(definition), 'dsh-team: 成员 tab 类型')
    // 开始页那张「成员」入口卡：按定义 id 注册自定义卡片，没命中就用默认卡。
    track(
      () => ctx.slots.inject('sidebar.right.tab.guide.entry', () => ctx.slots.register(
        { name: 'sidebar.right.tab.guide.entry', key: MEMBERS_TAB_ID, id: 'dsh-team/guide/members' },
        MembersGuideCard,
      )),
      'dsh-team: 开始页成员卡',
    )
    track(
      () => ctx.slots.inject(MEMBERS_SLOT, () => ctx.slots.register(
        { name: MEMBERS_SLOT, key: MEMBERS_TAB_ID },
        PanelSafe,
      )),
      'dsh-team: 成员 tab 正文',
    )

    return () => {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch {
          // 卸载阶段吞掉清理错误，避免连带拖垮插件。
        }
      }
    }
  }

  installOpenMembersPane()

  // BotEditor 也导出去：离线测试要能直接渲染它，不用去点面板。
  return { register, Panel, BotEditor }
}

    return {
      // ctx 只代理声明过的服务：没在这里写的服务，读到的永远是 undefined。
      // 只需要这三样：槽位（注册界面）、tab 类型（右栏页）、右栏（开页）。
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
      internals,
      apply(ctx) {
        /**
         * 注册一条槽位/效果。单条失败只记日志：不能因为一个槽位被占就带崩整次安装。
         * @param run - 注册动作。
         * @param label - 日志里的名字。
         */
        const safeEffect = (run, label) => {
          try {
            return typeof ctx.effect === 'function' ? ctx.effect(run, label) : run()
          } catch (error) {
            reportDiag({ event: 'slot-register-failed', where: label, build: BUILD_STAMP, error: String(error?.message ?? error) })
          }
        }
        // 离线测试要能直接渲染编辑器，正常路径不碰它。
        internals.createMembersPanel = createMembersPanel
        reportDiag({ event: 'apply', build: BUILD_STAMP })
        // 启动自检：缺哪个服务就记下来，面板顶上会显示。
        const required = ['slots', 'sidebarRightTabs', 'sidebarRight']
        SELF_CHECK.missing = required.filter((name) => {
          try {
            const service = typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name]
            return service === undefined
          } catch {
            return true
          }
        })
        SELF_CHECK.checked = true
        reportDiag({ event: 'selfcheck', build: BUILD_STAMP, missing: SELF_CHECK.missing })
        if (SELF_CHECK.missing.length > 0) {
          console.warn(`[dsh-team] 当前 DSH 缺这些服务，相关功能不可用：${SELF_CHECK.missing.join(', ')}`)
        }
        createMembersPanel(React, ctx).register(ctx)
        ctx.slots.inject('conversation.chat.markdown.fence', () =>
          ctx.slots.register(
            {
              name: 'conversation.chat.markdown.fence',
              key: 'member',
              id: 'dsh-team/fence/member',
            },
            MemberCard,
          ),
        )

        // dsh-avatar-frame 里点 Bot 的头像/ID 时，打开成员面板并定位到这个 Bot。
        ctx.effect(() => {
          const onOpenBot = (event) => {
            const botId = event?.detail?.botId
            if (typeof botId !== 'string' || botId === '') return
            pendingEditorBot = botId
            reportDiag({ event: 'open-bot', botId })
            let sidebar
            try {
              sidebar = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : ctx.sidebarRight
            } catch (error) {
              reportDiag({ event: 'open-bot-failed', where: 'service', error: String(error?.message ?? error) })
              return
            }
            if (!sidebar || typeof sidebar.openTab !== 'function') {
              reportDiag({ event: 'open-bot-failed', where: 'no-openTab' })
              return
            }
            try {
              // openTab 收的是 kind，不是 id：注册时 id=dsh-team/members、kind=dsh-team-members。
              sidebar.openTab(MEMBERS_TAB_KIND, { params: { bot: botId } })
            } catch (error) {
              reportDiag({ event: 'open-bot-failed', where: 'openTab', error: String(error?.message ?? error) })
            }
            // 面板可能已经开着：用事件让它切到编辑态，而不是只亮一下列表。
            try {
              window.dispatchEvent(new CustomEvent('dsh-team:open-bot-ui', { detail: { botId } }))
            } catch {
              // 事件派不出去不影响打开 tab。
            }
          }
          window.addEventListener('dsh-team:open-bot', onOpenBot)
          return () => window.removeEventListener('dsh-team:open-bot', onOpenBot)
        }, 'dsh-team: open bot settings')

        // 实时变更：主进程推 SSE，面板收到就立刻刷新；定时轮询只是兜底。
        ctx.effect(() => {
          if (typeof EventSource === 'undefined') return undefined
          let source
          try {
            source = new EventSource('/dsh-team/events')
          } catch {
            return undefined
          }
          const onMessage = (event) => {
            try {
              const payload = JSON.parse(event?.data ?? '{}')
              // 卡片已取消：交活内容改在「最近任务」里用文字展示。
              if (payload?.type === 'task-done') {
                document.getElementById('dsh-team-live-cards')?.remove()
              }
            } catch {
              // 不是 JSON 就只当成一次普通变更
            }
            try {
              window.dispatchEvent(new CustomEvent('dsh-team:changed'))
            } catch {
              // 派不出去就算了
            }
          }
          source.addEventListener('message', onMessage)
          return () => {
            source.removeEventListener('message', onMessage)
            source.close()
          }
        }, 'dsh-team: events')

        // 每 10 秒把会话→Bot 的映射同步给 dsh-avatar-frame（只写一个 localStorage 键）。
        ctx.effect(() => {
          if (typeof window === 'undefined' || typeof window.fetch !== 'function') return undefined
          void publishTeamIdentity(true)
          const timer = setInterval(() => void publishTeamIdentity(), 10_000)
          timer.unref?.()
          return () => clearInterval(timer)
        }, 'dsh-team: identity map')

        for (const slot of ['conversation.hero.options', 'conversation.composer.dock']) {
          safeEffect(
            () => ctx.slots.inject(slot, () => ctx.slots.register(
              { name: slot, id: `dsh-team/toggle/${slot}`, order: 5 },
              TeamToggle,
            )),
            `dsh-team: 开关 ${slot}`,
          )
        }
      },
    }
  },
})
