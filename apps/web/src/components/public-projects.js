// @ts-nocheck

function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  for (const child of Array.isArray(children) ? children : [children]) element.append(child instanceof Node ? child : String(child));
  return element;
}

export function publicProjectDirectory(data) {
  const section = node("section", {class: "public-project-directory", "aria-label": "Published projects"});
  if (!data.projects.length) section.append(node("p", {class: "state state--empty"}, "No public projects have been published yet."));
  else section.append(node("div", {class: "public-project-grid"}, data.projects.map(project => node("article", {class: "public-project-card"}, [
    node("p", {class: "eyebrow"}, "Public project · Read only"),
    node("h2", {}, node("a", {href: `/projects/project?initiativeId=${encodeURIComponent(project.initiativeId)}&projectId=${encodeURIComponent(project.id)}`}, project.name)),
    node("p", {}, "Follow this project’s roadmap, task progress and accepted outcomes.")
  ]))));
  if (data.truncated) section.append(node("p", {class: "state", role: "note"}, "This directory shows a bounded selection of published projects."));
  return section;
}
