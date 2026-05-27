import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#212121',
          surface: '#2f2f2f',
          input: '#2f2f2f',
          border: '#3f3f3f',
        },
        text: {
          DEFAULT: '#ececec',
          secondary: '#b0b0b0',
          muted: '#8e8ea0',
        },
        accent: {
          DEFAULT: '#19c37d',
          hover: '#0fa56b',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui'],
        mono: ['ui-monospace', 'SF Mono', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
