export function readingTitle(title: string, text: string, index: number) {
  const clean = (v: string) => v.replace(/[。！？\s]/g, "");
  return clean(title) === clean(text.split(/[。！？\n]/)[0] ?? "")
    ? `第${index + 1}章`
    : title;
}
