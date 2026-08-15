/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Bestehende Utility-Namen bleiben stabil; nur ihre Werte werden aus
        // den Theme-Tokens gelesen. Dadurch braucht der Light-Mode keinen
        // komponentenweisen Klassen-Fork.
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
          DEFAULT: '#dc2626',
          hover: '#b91c1c',
          glow: '#ef4444',
          dim: '#7f1d1d',
        },
        ok: '#10b981',
        warn: '#f59e0b',
        danger: '#ef4444',
        info: '#38bdf8',
        planned: '#7c3aed',
        severity: {
          neutral: '#6b7280',
          info: '#38bdf8',
          ok: '#10b981',
          warn: '#f59e0b',
          danger: '#ef4444',
          crit: '#b91c1c',
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
        glow: '0 0 60px rgba(220, 38, 38, 0.55)',
        'glow-sm': '0 0 22px rgba(220, 38, 38, 0.45)',
        'glow-lg': '0 0 120px rgba(220, 38, 38, 0.4)',
        card: '0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px rgba(0,0,0,0.5)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      backgroundImage: {
        'accent-gradient': 'linear-gradient(135deg, #dc2626 0%, #7f1d1d 100%)',
        'card-gradient': 'linear-gradient(180deg, rgba(220,38,38,0.04) 0%, rgba(0,0,0,0) 80%)',
        'panel-grid': 'radial-gradient(circle at 50% 0%, rgba(220,38,38,0.08), transparent 60%)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseGlow: {
          '0%, 100%': { boxShadow: '0 0 18px rgba(220,38,38,0.45)' },
          '50%': { boxShadow: '0 0 32px rgba(220,38,38,0.65)' },
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
