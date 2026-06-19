export default function Footer() {
  return (
    <footer style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexWrap: 'wrap',
      gap: 6,
      padding: '11px 20px calc(16px + var(--safe-bottom))',
      borderTop: '1px solid var(--border)',
    }}>
      <img
        src="/logos/heal-me.png"
        alt=""
        height={18}
        style={{ opacity: .65, objectFit: 'contain', verticalAlign: 'middle' }}
        onError={e => { e.target.style.display = 'none' }}
      />
      <span style={{
        color: 'var(--text-3)',
        fontSize: '.73rem',
        fontWeight: 500,
        opacity: .8,
      }}>
        Heal Me
      </span>
      <span style={{
        color: 'var(--border)',
        fontSize: '.8rem',
        margin: '0 1px',
        lineHeight: 1,
        userSelect: 'none',
      }}>
        |
      </span>
      <span style={{
        color: 'var(--text-4)',
        fontSize: '.73rem',
        fontWeight: 400,
        opacity: .8,
      }}>
        Powered by Neroes
      </span>
      <img
        src="/logos/neroes.png"
        alt=""
        height={18}
        style={{ opacity: .55, objectFit: 'contain', verticalAlign: 'middle' }}
        onError={e => { e.target.style.display = 'none' }}
      />
    </footer>
  )
}
