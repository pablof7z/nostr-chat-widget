/** @type {import('tailwindcss').Config}*/
const config = {
  content: ["./src/**/*.{html,js,svelte,ts}"],

  theme: {
    extend: {
      colors: {
        'purple': {
          100: 'var(--nostri-chat-custom-accent-color-100)',
          200: 'var(--nostri-chat-custom-accent-color-200)',
          300: 'var(--nostri-chat-custom-accent-color-300)',
          400: 'var(--nostri-chat-custom-accent-color-400)',
          500: 'var(--nostri-chat-custom-accent-color-500)',
          600: 'var(--nostri-chat-custom-accent-color-600)',
          700: 'var(--nostri-chat-custom-accent-color-700)',
          800: 'var(--nostri-chat-custom-accent-color-800)',
          900: 'var(--nostri-chat-custom-accent-color-900)',
        },
      },
    },
  },
  
  plugins: [require("@tailwindcss/forms")],
};

module.exports = config;
