import { openBrowser } from './browser.mjs';

export async function readObjects(page) {
  return page.locator('[data-object]').evaluateAll(elements => elements.map(element => ({
    text: element.textContent.trim(),
    key: element.getAttribute('data-key'),
    version: element.getAttribute('data-version'),
  })));
}

export async function inspect(base) {
  const session = await openBrowser(base);
  try {
    return await readObjects(session.page);
  } finally {
    await session.close();
  }
}
