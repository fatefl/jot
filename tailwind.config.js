/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        editor: "var(--editor-bg)",
        sidebar: "var(--sidebar-bg)",
        hover: "var(--hover)",
        border: "var(--border)",
        foreground: "var(--text)",
        secondary: "var(--text-secondary)",
        accent: "var(--accent)",
        "accent-soft": "var(--accent-soft)",
        glass: "var(--glass-bg)",
      },
      borderRadius: {
        DEFAULT: "8px",
        "2xl": "16px",
        xl: "12px",
      },
      boxShadow: {
        overlay: "0 4px 16px rgba(0,0,0,0.12)",
        "sm-soft": "0 1px 3px rgba(0,0,0,0.06)",
        "md-soft": "0 4px 12px rgba(0,0,0,0.08)",
        "lg-soft": "0 8px 32px rgba(0,0,0,0.10)",
        "xl-soft": "0 16px 48px rgba(0,0,0,0.12)",
      },
    },
  },
  plugins: [],
};
