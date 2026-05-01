import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Testbook Supercoaching brand
        brand: {
          pink: '#E8345C',     // Supercoaching pink
          navy: '#1B1A36',     // Testbook navy
          ink: '#0F0E22',      // deeper for hover/contrast
        },
        // Neutral surfaces (SaaS grey scale)
        surface: {
          0: '#FFFFFF',
          50: '#F8F9FB',
          100: '#F1F3F7',
          200: '#E5E8EE',
          300: '#CBD0D9',
          500: '#6B7280',
          700: '#374151',
          900: '#111827',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(15, 14, 34, 0.04), 0 1px 3px rgba(15, 14, 34, 0.06)',
      },
    },
  },
  plugins: [],
};
export default config;
