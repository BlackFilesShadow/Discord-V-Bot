/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: 'rgb(var(--color-bg) / <alpha-value>)',
          card: 'rgb(var(--color-bg-card) / <alpha-value>)',
          elev: 'rgb(var(--color-bg-elev) / <alpha-value>)',
          hover: 'rgb(var(--color-bg-hover) / <alpha-value>)',
          subtle: 'rgb(var(--color-bg-subtle) / <alpha-value>)',
        },
        white: 'rgb(var(--color-fg) / <alpha-value>)',
        muted: 'rgb(var(--color-muted) / <alpha-value>)',
        border: 'rgb(var(--color-border) / <alpha-value>)',
        accent: {
          DEFAULT: 'rgb(var(--color-accent) / <alpha-value>)',
          hover: 'rgb(var(--color-accent-hover) / <alpha-value>)',
          glow: 'rgb(var(--color-accent-glow) / <alpha-value>)',
          dim: 'rgb(var(--color-accent-dim) / <alpha-value>)',
        },
        ok: 'rgb(var(--color-ok) / <alpha-value>)',
        warn: 'rgb(var(--color-warn) / <alpha-value>)',
        danger: 'rgb(var(--color-danger) / <alpha-value>)',
        info: 'rgb(var(--color-info) / <alpha-value>)',
        planned: 'rgb(var(--color-planned) / <alpha-value>)',
        severity: {
          neutral: 'rgb(var(--color-neutral) / <alpha-value>)',
          info: 'rgb(var(--color-info) / <alpha-value>)',
          ok: 'rgb(var(--color-ok) / <alpha-value>)',
          warn: 'rgb(var(--color-warn) / <alpha-value>)',
          danger: 'rgb(var(--color-danger) / <alpha-value>)',
          crit: 'rgb(var(--color-danger) / <alpha-value>)',
        },
      },
      fontSize: {
        '2xs': ['10px', { lineHeight: '14px', letterSpacing: '0.04em' }],
        micro: ['9px', { lineHeight: '12px', letterSpacing: '0.06em' }],
      },
      spacing: {
        gutter: 'var(--gutter, 1.5rem)',
        row: 'var(--row-h, 2.5rem)',
      },
      maxWidth: {
        content: '76rem',
        'content-wide': '96rem',
      },
      zIndex: {
        modal: '60',
        toast: '70',
        palette: '80',
      },
      boxShadow: {
        glow: '0 0 60px rgb(var(--color-accent) / 0.38)',
        'glow-sm': '0 0 22px rgb(var(--color-accent) / 0.34)',
        'glow-lg': '0 0 120px rgb(var(--color-accent) / 0.30)',
        card: '0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px rgba(0,0,0,0.5)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      backgroundImage: {
        'accent-gradient': 'linear-gradient(135deg, rgb(var(--color-accent)) 0%, rgb(var(--color-accent-dim)) 100%)',
        'card-gradient': 'linear-gradient(180deg, rgb(var(--color-accent) / 0.045) 0%, rgba(0,0,0,0) 80%)',
        'panel-grid': 'radial-gradient(circle at 50% 0%, rgb(var(--color-accent) / 0.09), transparent 60%)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseGlow: {
          '0%, 100%': { boxShadow: '0 0 18px rgb(var(--color-accent) / 0.34)' },
          '50%': { boxShadow: '0 0 32px rgb(var(--color-accent) / 0.5)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 200ms ease-out',
        'pulse-glow': 'pulseGlow 2.5s ease-in-out infinite',
        shimmer: 'shimmer 1.6s linear infinite',
      },
    },
  },
  plugins: [],
};
