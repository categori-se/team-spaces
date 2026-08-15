/**
 * @param {string} name
 * @param {number} fallback
 */
function localPort(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : fallback;
}

const apiPort = localPort("PORT", 8787);
const webPort = localPort("WEB_PORT", 3000);
const localRuntimeConfig = JSON.stringify({
  apiBaseUrl: `http://localhost:${apiPort}/api/v1`,
  authMode: "demo",
  appOrigin: `http://localhost:${webPort}`,
  cognito: {
    domain: "",
    clientId: "",
    redirectUri: `http://localhost:${webPort}/app`,
    logoutUri: `http://localhost:${webPort}/`
  }
}).replaceAll("<", "\\u003c");

export default {
  title: "Team Spaces",
  pages: [
    {
      name: "Work",
      pages: [
        {name: "Overview", path: "/app"},
        {name: "My tasks", path: "/app/work"},
        {name: "Projects", path: "/app/projects"},
        {name: "Planning", path: "/app/planning"},
        {name: "Meetings", path: "/app/meetings"}
      ]
    },
    {
      name: "Workspace",
      pages: [
        {name: "Portfolio", path: "/app/portfolio"},
        {name: "Documents", path: "/app/documents"},
        {name: "Time", path: "/app/time"},
        {name: "Reports", path: "/app/reports"},
        {name: "Settings", path: "/app/admin"}
      ]
    }
  ],
  head: `
    <script>
      window.__TEAMSPACES_LOCAL_CONFIG__ = ${localRuntimeConfig};
      try {
        const theme = localStorage.getItem("teamspaces.theme");
        if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
      } catch {}
    </script>
    <link rel="icon" href="observable.png" type="image/png" sizes="32x32">
    <link rel="stylesheet" href="styles/theme.css">
    <meta name="color-scheme" content="light dark">
  `,
  root: "src",
  theme: "air",
  globalStylesheets: [],
  header: false,
  footer: false,
  search: true,
  toc: false,
  pager: false
};
