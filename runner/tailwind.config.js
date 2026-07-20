/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        panel: '#0f172a',
        panelAlt: '#111827',
        accent: '#38bdf8',
        danger: '#ef4444',
        success: '#22c55e',
        warn: '#f59e0b',
      },
    },
  },
  plugins: [],
};
