/**
 * Large, accessible button.
 * min-height 58px — well above WCAG 2.5.8 (24px) and elderly-friendly.
 * variants: primary | secondary | success | ghost
 */
export default function BigButton({
  children,
  onClick,
  disabled = false,
  variant = 'primary',
  className = '',
  style = {},
  'aria-label': ariaLabel,
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`btn btn-${variant} ${className}`}
      style={style}
    >
      {children}
    </button>
  )
}
