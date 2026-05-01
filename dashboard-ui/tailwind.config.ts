/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#0a0a0a',
          card: '#141414',
          elev: '#1c1c1c',
        },
        accent: {
          DEFAULT: '#dc2626', // red-600
          hover: '#b91c1c',   // red-700
          glow: '#ef4444',    // red-500
        },
        muted: '#6b7280',
        border: '#262626',
      },
      boxShadow: {
        glow: '0 0 60px #dc2626aa',
        'glow-sm': '0 0 20px #dc262680',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
