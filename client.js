/**
 * dsh-teamplan browser half.
 *
 * Two surfaces, one source of truth: a compact trailing badge on the session
 * row and a block appended inside the session hover card. Both read the same
 * polled snapshot, and both get their colour from the host's `tone` field so
 * the plugin and the route can never disagree.
 * @module dsh-teamplan/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-teamplan',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const STATE_URL = '/plugins/dsh-teamplan/state';
    const DISMISS_URL = '/plugins/dsh-teamplan/dismiss';
    const POLL_MS = 2000;

    /**
     * Warm "paper and ink" palette for everything we draw on the sidebar and in
     * our own panel. The host sidebar is a cool near-white, so our surfaces lean
     * warm on purpose: they read as a small paper slip laid on the shell rather
     * than a second copy of it. Every value below clears 4.5:1 on #F9FAFB.
     */
    const WARM = {
      surface: '#FBF5E9',
      surfaceRaised: '#FFFCF3',
      border: 'rgba(120, 92, 54, 0.20)',
      borderStrong: 'rgba(120, 92, 54, 0.32)',
      primary: '#3B3025',
      secondary: '#6E5F4B',
      tertiary: '#7C6A52',
      track: 'rgba(120, 92, 54, 0.16)',
      hover: 'rgba(120, 92, 54, 0.08)',
      shadow: '0 12px 32px rgba(74, 52, 22, 0.16), 0 2px 6px rgba(74, 52, 22, 0.08)',
    };

    /**
     * Semantic tones inside the same warm family: blue reads "running",
     * amber "blocked", olive "done", and a settled plan falls back to warm grey.
     * Two shades per tone: `TONE_COLOR` is the text/icon shade that has to stay
     * readable on paper, `TONE_FILL` is the lighter shade used for arcs and bars.
     */
    const TONE_COLOR = {
      grey: '#7C6A52',
      blue: '#2563A8',
      orange: '#B45309',
      green: '#4F7A2A',
    };

    /** Lighter twins for fills; contrast is not required here, only separation. */
    const TONE_FILL = {
      grey: 'rgba(124, 106, 82, 0.55)',
      blue: '#3D82C4',
      orange: '#E07B39',
      green: '#6BA84A',
    };

    /** Unfilled part of every progress ring. */
    const RING_TRACK = 'rgba(120, 92, 54, 0.18)';

    /** Reverse map so a passed colour resolves back to its fill twin. */
    const TONE_KEY = Object.fromEntries(Object.entries(TONE_COLOR).map(([key, value]) => [value, key]));

    const STEP_GLYPH = {
      done: '✓',
      doing: '▸',
      blocked: '!',
      pending: '·',
    };

    /**
     * The host hover card paints its own dark surface (`--dsw-alias-hovercard-bg`
     * is a static neutral-850) and sets no `color` of its own. We repaint it for
     * the cards that carry our block only: the selector keys off our marker, so
     * every other hover card keeps the host look, and the card is recoloured
     * through the same tokens it already reads instead of fighting its children.
     */
    const CARD_MARKER = 'data-teamplan-card';
    const CARD_CSS = [
      '[class*="_card_"]:has([' + CARD_MARKER + ']){',
      '--dsw-alias-hovercard-bg:' + WARM.surface + ';',
      '--dsw-alias-hovercard-label-primary:' + WARM.primary + ';',
      '--dsw-alias-hovercard-label-secondary:' + WARM.secondary + ';',
      '--dsw-alias-hovercard-label-tertiary:' + WARM.tertiary + ';',
      'background:' + WARM.surface + ';',
      'color:' + WARM.primary + ';',
      'border:1px solid ' + WARM.border + ';',
      'box-shadow:' + WARM.shadow + ';',
      '}',
    ].join('');

    /** Stable hooks for our own footer seat; the host class names are hashed. */
    const FOOT_CLASS = 'teamplan-foot-seat';
    const FOOT_BUTTON = 'teamplan-foot-btn';

    /**
     * Footer lane: the host stacks every footer action in one non-wrapping flex
     * row, so two plugins share a line. We want our entry on its own line above
     * the others (and above the remote seat), which needs the lane to wrap.
     */
    const FOOT_CSS = [
      '[class*="footerActions"]:has([data-slot="sidebar.footer.action"]){flex-wrap:wrap;}',
      '.' + FOOT_CLASS + '{flex:0 0 100%;order:-1;display:flex;justify-content:flex-start;margin:0;padding:0;}',
      '.' + FOOT_CLASS + '[data-rail="1"]{flex:0 0 auto;justify-content:center;}',
      '.' + FOOT_BUTTON + '{flex:0 0 auto;}',
    ].join('');

    // ---------------------------------------------------------------- store

    let snapshot = { plans: [], done: [], ready: false };
    const listeners = new Set();

    function getSnapshot() {
      return snapshot;
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }

    function publish(next) {
      const same = JSON.stringify([next.plans, next.done, next.ready])
        === JSON.stringify([snapshot.plans, snapshot.done, snapshot.ready]);
      if (same) return;
      snapshot = next;
      for (const listener of listeners) listener();
    }

    async function refresh() {
      try {
        const response = await fetch(STATE_URL, { cache: 'no-store' });
        if (!response.ok) return;
        const body = await response.json();
        if (!Array.isArray(body?.plans)) return;
        publish({ plans: body.plans, done: Array.isArray(body.done) ? body.done : [], ready: true });
      } catch {
        // A host restart or a not-yet-mounted route is normal: keep the last
        // snapshot and try again on the next tick.
      }
    }

    function usePlans() {
      return React.useSyncExternalStore(subscribe, getSnapshot);
    }

    /**
     * The panel is opened from the sidebar foot and closed from its own header,
     * from a row click, or by pressing the entry again. It lives outside the
     * sidebar tree (shell.overlay), so its open state cannot ride on any host
     * component's state.
     */
    /** Live bounding box of the footer seat, so the panel can anchor to it. */
    let seatRect = null;
    const seatListeners = new Set();

    function setSeatRect(next) {
      const same = seatRect === next
        || (seatRect !== null && next !== null
          && seatRect.top === next.top && seatRect.left === next.left
          && seatRect.width === next.width && seatRect.height === next.height);
      if (same) return;
      seatRect = next;
      for (const listener of seatListeners) listener();
    }

    function useSeatRect() {
      return React.useSyncExternalStore(
        (listener) => {
          seatListeners.add(listener);
          return () => seatListeners.delete(listener);
        },
        () => seatRect,
        () => null,
      );
    }

    let panelOpen = false;
    const panelListeners = new Set();

    function setPanelOpen(next) {
      if (next === panelOpen) return;
      panelOpen = next;
      for (const listener of panelListeners) listener();
    }

    /**
     * The footer entry and the panel are one hover target: moving from the seat
     * into the panel must not close it, so closing is deferred long enough to
     * cross the gap between them.
     */
    let closeTimer = null;

    function openPanel() {
      if (closeTimer !== null) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      setPanelOpen(true);
    }

    function closePanelSoon() {
      if (closeTimer !== null) clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        closeTimer = null;
        setPanelOpen(false);
      }, 180);
    }

    function usePanelOpen() {
      return React.useSyncExternalStore(
        (listener) => {
          panelListeners.add(listener);
          return () => {
            panelListeners.delete(listener);
          };
        },
        () => panelOpen,
      );
    }

    /** Jump into a session; wired to `uiWorkspace.openSession` when it binds. */
    let openSession = () => {};

    /**
     * Mark plans as read. `undefined` id means "everything on that tab", which
     * the host resolves itself so the client never guesses at retention rules.
     */
    async function dismissPlan(planId, scope) {
      const payload = typeof planId === 'string' && planId !== ''
        ? { planId }
        : { scope };
      try {
        await fetch(DISMISS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        await refresh();
      } catch {
        // The next poll reconciles whatever the host accepted.
      }
    }

    function planOfSession(plans, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined;
      return plans.find((plan) => plan.sessionId === sessionId);
    }

    // ----------------------------------------------------------- components

    /**
     * The sidebar row badge: a ring that also states the percentage, so the
     * progress is readable without hovering and without a second label.
     */
    function Badge({ sessionId }) {
      const { plans } = usePlans();
      const plan = planOfSession(plans, sessionId);
      if (plan === undefined) return null;
      const tone = plan.status === 'done' ? TONE_COLOR.green : (TONE_COLOR[plan.tone] ?? TONE_COLOR.grey);
      return h('span', {
        title: `${plan.title} · ${plan.statusLabel} · ${plan.percent}%（${plan.doneSteps}/${plan.totalSteps} 步）`,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          marginLeft: '6px',
          verticalAlign: 'middle',
        },
      }, h(Ring, { percent: plan.percent, tone, size: 20, stroke: 2.2 }));
    }

    function Bar({ percent, color, track = RING_TRACK, inset = 0 }) {
      return h('span', {
        style: {
          display: 'block',
          position: 'relative',
          height: '3px',
          borderRadius: '999px',
          background: track,
          overflow: 'hidden',
          marginTop: '6px',
          marginLeft: inset ? `${inset}px` : 0,
        },
      }, h('span', {
        style: {
          position: 'absolute',
          inset: '0 auto 0 0',
          width: `${Math.max(0, Math.min(100, percent))}%`,
          background: color,
          borderRadius: '999px',
        },
      }));
    }

    function Hover({ sessionId }) {
      const { plans } = usePlans();
      const plan = planOfSession(plans, sessionId);
      if (plan === undefined) return null;
      const color = TONE_COLOR[plan.tone] ?? TONE_COLOR.grey;
      const fill = TONE_FILL[plan.tone] ?? TONE_FILL.grey;
      const shown = plan.steps.slice(0, 5);
      const rest = plan.steps.length - shown.length;
      return h('div', {
        [CARD_MARKER]: '',
        style: {
          marginTop: '8px',
          paddingTop: '8px',
          borderTop: `1px solid ${WARM.border}`,
          fontSize: '11px',
          lineHeight: '16px',
          color: WARM.primary,
        },
      }, [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'baseline', gap: '6px', justifyContent: 'space-between' },
        }, [
          h('span', {
            key: 'title',
            style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, plan.title),
          h('span', {
            key: 'pct',
            style: { color, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' },
          }, `${plan.percent}%`),
        ]),
        h(Bar, { key: 'bar', percent: plan.percent, color: fill, track: WARM.track }),
        h('div', {
          key: 'meta',
          style: { marginTop: '5px', color: WARM.secondary, display: 'flex', gap: '8px', justifyContent: 'space-between' },
        }, [
          h('span', { key: 'count' }, `${plan.doneSteps}/${plan.totalSteps} 步 · ${plan.statusLabel}`),
          h('span', { key: 'mins', style: { fontVariantNumeric: 'tabular-nums' } }, `${plan.doneMinutes}/${plan.totalMinutes} 分钟`),
        ]),
        h('div', { key: 'steps', style: { marginTop: '5px' } }, shown.map((step) => h('div', {
          key: step.id,
          style: { display: 'flex', gap: '5px', alignItems: 'baseline' },
        }, [
          h('span', {
            key: 'g',
            style: {
              flex: '0 0 10px',
              color: step.status === 'blocked' || step.stalled
                ? TONE_COLOR.orange
                : step.status === 'done' ? TONE_COLOR.green : WARM.tertiary,
            },
          }, step.stalled ? '!' : (STEP_GLYPH[step.status] ?? '·')),
          h('span', {
            key: 't',
            style: {
              flex: '1 1 auto',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: step.status === 'done' ? WARM.tertiary : WARM.primary,
              textDecoration: step.status === 'done' ? 'line-through' : 'none',
            },
          }, step.title),
        ]))),
        rest > 0 ? h('div', { key: 'rest', style: { marginTop: '2px', color: WARM.tertiary } }, `还有 ${rest} 步`) : null,
      ]);
    }

    // ------------------------------------------------------------- ring glyph

    function clampPercent(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return 0;
      return Math.max(0, Math.min(100, Math.round(n)));
    }

    /**
     * One coloured progress ring, used by all three surfaces so the row badge,
     * the footer entry and the panel can never drift apart.
     *
     * The arc is an SVG circle rather than a stacked border, so it stays crisp at
     * any DPI and a 7%-step reads as an arc instead of a painted dot. The number
     * sits inside from 18px upwards; below that the ring alone carries it and the
     * surrounding text supplies the value.
     */
    function Ring({ percent, tone, size = 20, stroke = 2, showValue = true }) {
      const toneKey = TONE_KEY[tone] ?? 'grey';
      const pct = clampPercent(percent);
      const radius = (size - stroke) / 2;
      const circumference = 2 * Math.PI * radius;
      const filled = (circumference * pct) / 100;
      const settled = pct >= 100;
      const value = showValue && size >= 18;
      return h('span', {
        style: {
          position: 'relative',
          display: 'inline-block',
          flex: '0 0 auto',
          width: `${size}px`,
          height: `${size}px`,
          verticalAlign: 'middle',
        },
      }, [
        h('svg', {
          key: 'svg',
          width: size,
          height: size,
          viewBox: `0 0 ${size} ${size}`,
          style: { display: 'block', transform: 'rotate(-90deg)' },
        }, [
          h('circle', {
            key: 'track',
            cx: size / 2,
            cy: size / 2,
            r: radius,
            fill: 'none',
            stroke: RING_TRACK,
            strokeWidth: stroke,
          }),
          h('circle', {
            key: 'arc',
            cx: size / 2,
            cy: size / 2,
            r: radius,
            fill: 'none',
            stroke: TONE_FILL[toneKey] ?? tone,
            strokeWidth: stroke,
            strokeLinecap: 'round',
            strokeDasharray: `${filled} ${Math.max(0, circumference - filled)}`,
            style: settled ? undefined : { transition: 'stroke-dasharray 360ms cubic-bezier(0.22, 0.61, 0.36, 1)' },
          }),
        ]),
        value ? h('span', {
          key: 'value',
          style: {
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: size >= 24 ? '10px' : size >= 22 ? '9.5px' : '8.5px',
            fontWeight: 600,
            lineHeight: 1,
            letterSpacing: '-0.02em',
            fontVariantNumeric: 'tabular-nums',
            color: tone,
          },
        }, settled ? '✓' : String(pct)) : null,
      ]);
    }

    // ------------------------------------------------------------- foot entry

    /**
     * The sidebar footer entry.
     *
     * The footer is a single lane shared with other plugins (the remote entry
     * among them, at order 0), and the host contract gives every occupant one
     * 42px labelled row or a 36px icon target — never a full-width bar. Claiming
     * `flex: 1 1 100%` here is what used to push this entry on top of the remote
     * one; this version sizes itself exactly like its neighbour.
     */
    /** Static glyph for the footer seat: a stack of work lines, no numbers. */
    function EntryIcon({ color }) {
      return h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        style: { display: 'block', flex: '0 0 auto', color },
      }, [
        h('path', { key: 'a', d: 'M2.5 4.25h11', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('path', { key: 'b', d: 'M2.5 8h7.5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('path', { key: 'c', d: 'M2.5 11.75h4.5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      ]);
    }

    function FootEntry({ wide }) {
      const { plans } = usePlans();
      const open = usePanelOpen();
      const rail = wide === false;
      const count = plans.length;
      const blocked = plans.filter((plan) => plan.tone === 'orange').length;
      const tone = blocked > 0 ? TONE_COLOR.orange : count > 0 ? TONE_COLOR.blue : TONE_COLOR.grey;
      const summary = count === 0 ? '进展：没有进行中的任务' : `进展：${count} 项进行中${blocked > 0 ? `，${blocked} 项受阻` : ''}`;
      const ref = React.useRef(null);
      const measure = React.useCallback(() => {
        const element = ref.current;
        if (element === null) return;
        const box = element.getBoundingClientRect();
        setSeatRect({ top: box.top, left: box.left, width: box.width, height: box.height });
      }, []);
      React.useEffect(() => {
        measure();
        window.addEventListener('resize', measure);
        return () => {
          window.removeEventListener('resize', measure);
        };
      }, [measure]);
      return h('div', { className: FOOT_CLASS, 'data-rail': rail ? '1' : '0' }, h('button', {
        ref,
        type: 'button',
        className: FOOT_BUTTON,
        // No native `title`: the seat already announces itself through
        // aria-label, and a browser tooltip would cover the panel we anchor
        // right above it.
        'aria-label': summary,
        'aria-expanded': open,
        onClick: () => setPanelOpen(!open),
        onMouseEnter: () => {
          measure();
          openPanel();
        },
        onMouseLeave: closePanelSoon,
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: rail ? 'center' : 'flex-start',
          gap: rail ? '0' : 'var(--dsh-sidebar-label-gap, 6px)',
          boxSizing: 'border-box',
          width: rail ? '36px' : 'auto',
          minWidth: '36px',
          maxWidth: '100%',
          height: rail ? '36px' : '42px',
          margin: '1px 2px',
          padding: rail ? '0' : '0 calc(var(--dsh-sidebar-row-padding, 12px) - var(--dsh-sidebar-paint-inset, 3px))',
          border: 'none',
          borderRadius: 'var(--dsw-radius-md, 12px)',
          background: open ? WARM.hover : 'transparent',
          color: open ? WARM.primary : 'var(--dsw-alias-label-secondary, #5A5F6A)',
          font: 'inherit',
          fontSize: '14px',
          lineHeight: '22px',
          cursor: 'pointer',
          textAlign: 'start',
          overflow: 'hidden',
        },
      }, [
        h(EntryIcon, { key: 'icon', color: count === 0 ? 'currentColor' : tone }),
        rail ? null : h('span', {
          key: 'text',
          style: { flex: '0 0 auto', whiteSpace: 'nowrap' },
        }, '进展'),
        rail || count === 0 ? null : h('span', {
          key: 'count',
          style: { flex: '0 0 auto', color: tone, fontSize: '13px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
        }, String(count)),
      ]));
    }

    // ------------------------------------------------------- all-plans panel

    function TabButton({ active, onClick, children }) {
      return h('button', {
        type: 'button',
        onClick,
        style: {
          flex: '1 1 0',
          padding: '5px 8px',
          border: 'none',
          borderRadius: '8px',
          background: active ? WARM.surfaceRaised : 'transparent',
          boxShadow: active ? '0 1px 2px rgba(74, 52, 22, 0.12)' : 'none',
          color: active ? WARM.primary : WARM.tertiary,
          font: 'inherit',
          fontSize: '11px',
          fontWeight: active ? 600 : 400,
          cursor: 'pointer',
          transition: 'background 160ms ease, color 160ms ease',
        },
      }, children);
    }

    function PlanRow({ row, finished }) {
      const tone = TONE_COLOR[row.tone] ?? TONE_COLOR.grey;
      return h('div', {
        role: 'button',
        tabIndex: 0,
        onClick: () => {
          openSession(row.sessionId);
          setPanelOpen(false);
          // A finished plan leaves the list once you jump to it: it has served
          // its purpose, and the record stays on disk for the audit trail.
          if (finished) void dismissPlan(row.planId);
        },
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openSession(row.sessionId);
            setPanelOpen(false);
            if (finished) void dismissPlan(row.planId);
          }
        },
        style: {
          padding: '7px 8px',
          borderRadius: '9px',
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
        },
      }, [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'center', gap: '8px' },
        }, [
          h(Ring, { key: 'ring', percent: row.percent, tone, size: 22, stroke: 2.4 }),
          h('span', {
            key: 'title',
            style: {
              flex: '1 1 auto',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: WARM.primary,
              fontSize: '12px',
            },
          }, row.title),
        ]),
        h(Bar, { key: 'bar', percent: row.percent, color: TONE_FILL[TONE_KEY[tone]] ?? tone, track: WARM.track, inset: 30 }),
        h('div', {
          key: 'meta',
          style: { display: 'flex', alignItems: 'center', gap: '6px', color: WARM.secondary, fontSize: '10px' },
        }, [
          h('span', { key: 'steps', style: { flex: '1 1 auto' } }, `${row.doneSteps}/${row.totalSteps} 步 · ${row.statusLabel}`),
          h('button', {
            key: 'dismiss',
            type: 'button',
            title: '已读后不再出现在列表里，会话本身不受影响',
            'aria-label': `把「${row.title}」标为已读`,
            onClick: (event) => {
              event.stopPropagation();
              void dismissPlan(row.planId, undefined);
            },
            style: {
              flex: '0 0 auto',
              padding: '0 7px',
              borderRadius: '7px',
              border: `1px solid ${WARM.border}`,
              background: WARM.surfaceRaised,
              color: WARM.secondary,
              font: 'inherit',
              fontSize: '10px',
              lineHeight: '18px',
              cursor: 'pointer',
            },
          }, '已读'),
        ]),
      ]);
    }

    /**
     * Every plan in one place, anchored to the foot that opens it. Rendered into
     * `shell.overlay` because the sidebar column clips its own overflow.
     */
    function Panel() {
      const open = usePanelOpen();
      const { plans, done } = usePlans();
      const [tab, setTab] = React.useState('active');
      const [readNotice, setReadNotice] = React.useState('');
      React.useEffect(() => {
        setReadNotice('');
      }, [tab]);
      const readAll = React.useCallback(async () => {
        const scope = tab;
        const count = scope === 'active' ? plans.length : done.length;
        if (count === 0) return;
        await dismissPlan(undefined, scope);
        setReadNotice(`已读 ${count} 项，列表已清空`);
      }, [tab, plans.length, done.length]);
      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') setPanelOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => {
          window.removeEventListener('keydown', onKey);
        };
      }, [open]);
      // Every hook has to run before the early return, or React sees a changed
      // hook order the first time the panel opens and tears the surface down.
      const rect = useSeatRect();
      if (!open) return null;
      const rows = tab === 'active' ? plans : done;
      const width = 312;
      const gap = 8;
      const anchored = rect !== null && rect.width > 0;
      const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth;
      const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight;
      const left = anchored
        ? Math.max(8, Math.min(rect.left, Math.max(8, viewportWidth - width - 8)))
        : 10;
      const bottom = anchored ? Math.max(8, viewportHeight - rect.top + gap) : 104;
      return h('div', {
        onMouseEnter: openPanel,
        onMouseLeave: closePanelSoon,
        style: {
          position: 'fixed',
          left: `${left}px`,
          bottom: `${bottom}px`,
          zIndex: 60,
          width: `${width}px`,
          height: 'min(360px, 52vh)',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: '14px',
          background: WARM.surface,
          border: `1px solid ${WARM.border}`,
          boxShadow: WARM.shadow,
          color: WARM.primary,
          fontSize: '11px',
          lineHeight: '16px',
          overflow: 'hidden',
        },
      }, [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 12px 8px' },
        }, [
          h('span', { key: 't', style: { flex: '1 1 auto', fontSize: '12.5px', fontWeight: 600, letterSpacing: '0.01em' } }, '全部任务'),
          h('button', {
            key: 'read-all',
            type: 'button',
            // No native title here either: the tooltip would float over the tabs.
            'aria-label': tab === 'active' ? '把进行中的任务全部标为已读' : '把已完成的任务全部标为已读',
            onClick: () => {
              void readAll();
            },
            style: {
              flex: '0 0 auto',
              padding: '0 8px',
              height: '22px',
              borderRadius: '7px',
              border: `1px solid ${WARM.border}`,
              background: WARM.surfaceRaised,
              color: WARM.secondary,
              font: 'inherit',
              fontSize: '10.5px',
              cursor: 'pointer',
            },
          }, '全部已读'),
          h('button', {
            key: 'close',
            type: 'button',
            title: '收起（Esc）',
            'aria-label': '收起',
            onClick: () => setPanelOpen(false),
            style: {
              flex: '0 0 auto',
              width: '22px',
              height: '22px',
              borderRadius: '7px',
              border: 'none',
              background: 'transparent',
              color: WARM.tertiary,
              font: 'inherit',
              fontSize: '15px',
              lineHeight: '20px',
              cursor: 'pointer',
            },
          }, '×'),
        ]),
        h('div', {
          key: 'tabs',
          style: {
            display: 'flex',
            gap: '2px',
            margin: '0 10px 8px',
            padding: '2px',
            borderRadius: '10px',
            background: WARM.hover,
          },
        }, [
          h(TabButton, {
            key: 'active',
            active: tab === 'active',
            onClick: () => setTab('active'),
          }, `进行中 ${plans.length}`),
          h(TabButton, {
            key: 'done',
            active: tab === 'done',
            onClick: () => setTab('done'),
          }, `已完成 ${done.length}`),
        ]),
        h('div', {
          key: 'list',
          style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '0 8px 10px', display: 'flex', flexDirection: 'column', gap: '3px' },
        }, rows.length === 0
          ? [h('div', {
            key: 'empty',
            style: {
              flex: '1 1 auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '18px 8px',
              textAlign: 'center',
              color: WARM.tertiary,
              fontSize: '11px',
            },
          }, readNotice !== ''
            ? readNotice
            : (tab === 'active' ? '没有进行中的任务' : '最近 3 天没有完成的任务'))]
          : rows.map((row) => h(PlanRow, { key: row.planId, row, finished: tab === 'done' }))),
      ]);
    }

    // ------------------------------------------------------------------ api

    // A render error inside one surface must stay inside that surface: without
    // a boundary React unmounts the whole shell and the window goes blank.
    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        console.warn('[teamplan] surface failed', error);
      }

      render() {
        return this.state.failed ? null : this.props.children;
      }
    }

    function guarded(Component) {
      return function GuardedSurface(props) {
        return h(Boundary, null, h(Component, props));
      };
    }

    // One surface failing must never take the whole shell down: each slot is
    // mounted on its own, and a missing or renamed slot only costs that surface.
    const PANEL_ENABLED = true;

    const SURFACES = [
      ['sidebar.session.row.trailing', 'teamplan-badge', 30, guarded(Badge)],
      ['sidebar.session.row.hover', 'teamplan-hover', 30, guarded(Hover)],
      ['sidebar.footer.action', 'teamplan-foot', 10, guarded(FootEntry)],
      ...(PANEL_ENABLED ? [['shell.overlay', 'teamplan-panel', 40, guarded(Panel)]] : []),
    ];

    function mountSurfaces(ctx) {
      for (const [name, id, order, Component] of SURFACES) {
        try {
          ctx.slots.inject(name, () => ctx.slots.register({ name, id, order }, Component));
        } catch (error) {
          console.warn(`[teamplan] cannot mount ${name}`, error);
        }
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.effect(() => {
            let timer;
            const tick = () => {
              void refresh();
            };
            tick();
            timer = window.setInterval(tick, POLL_MS);
            return () => {
              window.clearInterval(timer);
            };
          }, 'teamplan: state polling');
        } catch (error) {
          console.warn('[teamplan] polling unavailable', error);
        }

        try {
          ctx.effect(() => {
            const style = document.createElement('style');
            style.setAttribute('data-teamplan-styles', '');
            style.textContent = CARD_CSS + FOOT_CSS;
            document.head.appendChild(style);
            return () => {
              style.remove();
            };
          }, 'teamplan: styles');
        } catch (error) {
          console.warn('[teamplan] styles unavailable', error);
        }

        try {
          mountSurfaces(ctx);
        } catch (error) {
          console.warn('[teamplan] slot registry unavailable', error);
        }

        // Session jumping is optional: without it a click still closes the
        // panel, so the surface degrades instead of breaking.
        try {
          if (typeof ctx.inject === 'function') {
            ctx.inject(['uiWorkspace'], (scope) => {
              const workspace = scope.uiWorkspace ?? scope.get?.('uiWorkspace');
              if (workspace !== undefined && typeof workspace.openSession === 'function') {
                openSession = (sessionId) => {
                  try {
                    workspace.openSession(sessionId);
                  } catch {
                    /* an unknown or archived session is not worth an error */
                  }
                };
              }
            });
          }
        } catch (error) {
          console.warn('[teamplan] session jump unavailable', error);
        }
      },
    };
  },
});
