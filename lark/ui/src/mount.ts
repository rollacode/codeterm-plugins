export function mountView(document: Pick<Document, "getElementById">, render: (root: HTMLElement) => void): void {
  const root = document.getElementById("ct-root");
  if (root) render(root);
}
