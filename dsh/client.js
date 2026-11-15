// Browser half of the adapter: a "Self-improvement loop" tab in the DSH right sidebar.
// Hand-written in the bundle form DSH loads, so the adapter needs no build step.
window.__ModuleLoader__.load({
  id: '@kolezka/self-improvement-loop-dsh',
  factory: (require) => {
    const { jsx } = require('react/jsx-runtime')

    const TAB_ID = '@kolezka/self-improvement-loop-dsh'
    const TAB_KIND = 'self-improvement-loop'
    const TITLE = 'Self-improvement loop'
    // No leading slash: the address follows the DSH page, also behind a path prefix.
    const CONSOLE_ADDRESS = 'self-improvement-loop/'
    const FRAME_STYLE = { border: 0, width: '100%', height: '100%', display: 'block' }

    const inject = ['slots', 'sidebarRightTabs']

    function ConsoleBody({ address }) {
      return jsx('iframe', { src: address, title: TITLE, style: FRAME_STYLE })
    }

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            title: () => TITLE,
            // The console is one per machine, not per session, so keep it loaded across switches.
            keepMounted: true,
            guide: [{ id: 'open', order: 45, title: () => TITLE, description: () => 'Review lessons and proposals the loop staged' }],
          }),
        'self-improvement-loop: tab type',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              { name: 'sidebar.right.pane.tab', key: TAB_ID, inject: () => ({ address: CONSOLE_ADDRESS }) },
              ConsoleBody,
            ),
          ),
        'self-improvement-loop: tab body',
      )
    }

    return { apply, inject }
  },
})
