/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#08080a',
          card: '#111114',
          elev: '#181820',
          hover: '#22222c',
          subtle: '#0c0c10',
        },
        accent: {
          DEFAULT: '#dc2626',
          hover: '#b91c1c',
          glow: '#ef4444',
          dim: '#7f1d1d',
        },
        muted: '#6b7280',
        border: '#262630',
        ok: '#10b981',
        warn: '#f59e0b',
        danger: '#ef4444',
        info: '#38bdf8',
        planned: '#7c3aed',
        // Severity-Skala fuer enterprise-typische Status-Anzeigen
        severity: {
          neutral: '#6b7280',
          info:    '#38bdf8',
          ok:      '#10b981',
          warn:    '#f59e0b',
          danger:  '#ef4444',
          crit:    '#b91c1c',
        },
      },
      fontSize: {
        // Enterprise-Typo-Skala (kompakter als Default)
        '2xs': ['10px', { lineHeight: '14px', letterSpacing: '0.04em' }],
        'micro': ['9px',  { lineHeight: '12px', letterSpacing: '0.06em' }],
      },
      spacing: {
        // Density-aware Basis (mit CSS-Vars in index.css gepaart)
        'gutter': 'var(--gutter, 1.5rem)',
        'row':    'var(--row-h, 2.5rem)',
      },
      maxWidth: {
        'content':       '76rem',  // 1216px — Standard-Content-Container
        'content-wide':  '96rem',  // 1536px — fuer Tabellen/Heatmaps
      },
      zIndex: {
        modal:   '60',
        toast:   '70',
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
          '50%':      { boxShadow: '0 0 32px rgba(220,38,38,0.65)' },
        },
        shimmer: {
          '0%':   { backgroundPosition: '-200% 0' },
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
