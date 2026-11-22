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
export const MEMBERS_TAB_ID = 'dsh-team/members'

/** tab 类型判别值；`ctx.sidebarRight.openTab` 用它开页。 */
export const MEMBERS_TAB_KIND = 'dsh-team-members'

/** 右栏 tab 正文的槽位名（keyed，scope 为 session）。 */
export const MEMBERS_SLOT = 'sidebar.right.pane.tab'

/**
 * 演示用成员表。字段：
 *  - id     成员名，头像取它的首字
 *  - role   职责
 *  - status busy | idle | offline，决定分组与状态色
 *  - tasks  手上几件活
 * 真实数据接上后，这个常量只留作空数据时的兜底或直接删掉。
 */
export const DEMO_MEMBERS = [
  { id: 'nova', role: '研究员', status: 'busy', tasks: 1 },
  { id: 'forge', role: '审图', status: 'idle', tasks: 0 },
  { id: 'echo', role: '写作', status: 'offline', tasks: 0 },
]

/** 分组顺序：先忙、再空闲、最后离线。 */
const STATUS_ORDER = ['busy', 'idle', 'offline']

const STATUS_META = {
  busy: { label: '忙', color: 'var(--dsw-alias-state-warn-primary, #d29922)' },
  idle: { label: '空闲', color: 'var(--dsw-alias-state-success-primary, #3fb950)' },
  offline: { label: '离线', color: 'var(--dsw-alias-label-tertiary, #8a8f98)' },
}

/** 只用 --dsw-alias-* 设计令牌，后面跟回退值；不写死主题色。 */
const COLOR = {
  text: 'var(--dsw-alias-label-primary, #e6e6e6)',
  secondary: 'var(--dsw-alias-label-secondary, #a8adb5)',
  tertiary: 'var(--dsw-alias-label-tertiary, #7d838c)',
  border: 'var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.24))',
  surface: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.07))',
  avatar: 'var(--dsw-alias-bg-layer-4, rgba(128, 128, 128, 0.18))',
}

/** 成员卡高度，长方形卡片。 */
const CARD_HEIGHT = 56

/**
 * 造出成员面板：正文组件 + 注册函数。
 * @param React - React 实现（由加载器传入，便于离屏测试）。
 * @returns `{ register(ctx), Panel }`。
 */
export function createMembersPanel(React) {
  if (typeof React?.createElement !== 'function') {
    throw new Error('createMembersPanel: 需要传入 React（缺少 createElement）')
  }
  const h = React.createElement

  /** 头像里的首字。 */
  function initial(name) {
    const clean = String(name ?? '').trim()
    return clean === '' ? '?' : clean.slice(0, 1).toUpperCase()
  }

  function statusOf(key) {
    return STATUS_META[key] ?? { label: key ? String(key) : '—', color: COLOR.tertiary }
  }

  /** 按状态分组：已知状态按 STATUS_ORDER 排，未知状态并进「其他」。 */
  function groupMembers(members) {
    const buckets = new Map(STATUS_ORDER.map((key) => [key, []]))
    const other = []
    for (const member of members) {
      const bucket = buckets.get(member?.status)
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

  /** 右上角占位按钮：只 console.log，等真实功能接上再换 onClick。 */
  function HeaderButton({ label, glyph, action }) {
    return h(
      'button',
      {
        type: 'button',
        'aria-label': label,
        title: label,
        onClick: () => {
          console.log(`[dsh-team] 成员面板：${action}（占位，尚未实现）`)
        },
        style: {
          width: 24,
          height: 24,
          display: 'grid',
          placeItems: 'center',
          padding: 0,
          border: 'none',
          borderRadius: 6,
          background: 'transparent',
          color: COLOR.secondary,
          fontSize: 14,
          lineHeight: 1,
          cursor: 'pointer',
        },
      },
      glyph,
    )
  }

  /** 一张长方形成员卡：左圆头像，右侧名字+职责 / 状态+手上 N 件。 */
  function MemberCard({ member }) {
    const meta = statusOf(member?.status)
    const tasks = Number.isFinite(member?.tasks) ? member.tasks : 0
    return h(
      'div',
      {
        'data-dsh-team-member': member?.id,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: CARD_HEIGHT,
          boxSizing: 'border-box',
          padding: '0 10px',
          border: `1px solid ${COLOR.border}`,
          borderRadius: 6,
          background: COLOR.surface,
        },
      },
      h(
        'div',
        {
          'aria-hidden': true,
          style: {
            flex: '0 0 auto',
            width: 32,
            height: 32,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            fontSize: 13,
            fontWeight: 600,
            color: COLOR.text,
            background: COLOR.avatar,
          },
        },
        initial(member?.id),
      ),
      h(
        'div',
        {
          style: {
            flex: '1 1 auto',
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 } },
          h(
            'span',
            {
              style: {
                fontWeight: 600,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            },
            member?.id,
          ),
          h(
            'span',
            {
              style: {
                fontSize: 12,
                color: COLOR.secondary,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            },
            member?.role,
          ),
        ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              minWidth: 0,
              fontSize: 12,
              color: COLOR.secondary,
            },
          },
          h('span', {
            'aria-hidden': true,
            style: {
              flex: '0 0 auto',
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: meta.color,
            },
          }),
          h('span', { style: { whiteSpace: 'nowrap' } }, meta.label),
          h(
            'span',
            {
              style: {
                color: COLOR.tertiary,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            },
            `· 手上 ${tasks} 件`,
          ),
        ),
      ),
    )
  }

  /**
   * 右栏 tab 正文。插槽把运行时 props 交进来；以后真实成员列表通过 `inject`
   * 放在 `props.members` 里，这里就直接用了。
   * @param props - 插槽 props，可选 `members: Array`。
   */
  function Panel(props) {
    const members = Array.isArray(props?.members) ? props.members : DEMO_MEMBERS
    const groups = groupMembers(members)

    const header = h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto' } },
      h('span', { style: { fontWeight: 600 } }, '成员'),
      h('span', { style: { fontSize: 11, color: COLOR.tertiary } }, String(members.length)),
      h(
        'div',
        { style: { marginLeft: 'auto', display: 'flex', gap: 2 } },
        h(HeaderButton, { key: 'add', label: '添加成员', glyph: '＋', action: '添加成员' }),
        h(HeaderButton, { key: 'settings', label: '成员设置', glyph: '⚙', action: '打开成员设置' }),
      ),
    )

    const body = members.length === 0
      ? h(
          'div',
          {
            style: {
              flex: '1 1 auto',
              display: 'grid',
              placeItems: 'center',
              color: COLOR.tertiary,
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
              gap: 10,
              minHeight: 0,
              overflowY: 'auto',
            },
          },
          groups.map((group) => h(
            'div',
            { key: group.key, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h(
              'div',
              { style: { fontSize: 11, color: COLOR.secondary } },
              `${group.meta.label} · ${group.items.length}`,
            ),
            group.items.map((member) => h(MemberCard, { key: member.id, member })),
          )),
        )

    return h(
      'div',
      {
        'data-dsh-team-members': '',
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          height: '100%',
          minHeight: 0,
          boxSizing: 'border-box',
          padding: '8px 10px 12px',
          fontSize: 13,
          lineHeight: 1.4,
          color: COLOR.text,
        },
      },
      header,
      body,
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
      const dispose = typeof ctx.effect === 'function' ? ctx.effect(run, label) : run()
      if (typeof dispose === 'function') disposers.push(dispose)
    }

    track(() => ctx.sidebarRightTabs.register(definition), 'dsh-team: 成员 tab 类型')
    track(
      () => ctx.slots.inject(MEMBERS_SLOT, () => ctx.slots.register(
        { name: MEMBERS_SLOT, key: MEMBERS_TAB_ID },
        Panel,
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

  return { register, Panel }
}
