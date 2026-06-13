/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#171717",
        graphite: "#3f3d46",
        porcelain: "#efeeeb",
        paper: "#fbfaf7",
        mist: "#d7d2ca",
        lavender: "#c9a7ff",
        signal: "#0f0f0f",
      },
      boxShadow: {
        panel: "0 1px 2px rgba(20, 20, 20, 0.08)",
      },
    },
  },
  plugins: [],
};
