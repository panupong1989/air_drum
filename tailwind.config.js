/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0a0a12",
        "bg-grid": "#14142b",
        hihat: "#fde047",
        snare: "#f43f5e",
        tom: "#38bdf8",
        muted: "#71717a",
      },
      fontFamily: {
        display: ['"Bungee"', "cursive"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
      animation: {
        "hit-flash": "hit-flash 180ms ease-out",
        "pulse-ring": "pulse-ring 500ms ease-out forwards",
        scanline: "scanline 4s linear infinite",
        "blink-dot": "blink-dot 1s ease-in-out infinite",
      },
      keyframes: {
        "hit-flash": {
          "0%": { transform: "scale(1)" },
          "50%": { transform: "scale(1.15)" },
          "100%": { transform: "scale(1)" },
        },
        "pulse-ring": {
          "0%": { transform: "scale(0.8)", opacity: "1" },
          "100%": { transform: "scale(2.2)", opacity: "0" },
        },
        scanline: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100vh)" },
        },
        "blink-dot": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.25" },
        },
      },
    },
  },
  plugins: [],
};
