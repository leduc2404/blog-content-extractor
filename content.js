/**
 * Blog Content Extractor - Content Script v2.0
 * Converts HTML content to Markdown format compatible with blog import.
 * Supports: H1-H6, bold, italic, underline, strikethrough, blockquote,
 *           lists, code, tables, images (including lazy-load & CSS bg-image),
 *           picture elements, links, and more.
 */

(function () {
  'use strict';

  // =====================================================================
  // HELPERS
  // =====================================================================

  /** Resolve a relative URL to an absolute one based on current page origin. */
  function resolveUrl(url) {
    if (!url || url.trim() === '') return '';
    url = url.trim();
    if (url.startsWith('data:')) return url;
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    try {
      return new URL(url, window.location.href).href;
    } catch {
      return url;
    }
  }

  /** Encode special characters that break Markdown link syntax. */
  function safeMarkdownUrl(url) {
    if (!url) return '';
    return url.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20').replace(/\[/g, '%5B').replace(/\]/g, '%5D');
  }

  /** Return true if a URL looks like a tiny placeholder/icon (not real content). */
  function isPlaceholderSrc(src) {
    if (!src) return true;
    const lower = src.toLowerCase();
    if (
      lower.includes('placeholder') ||
      lower.includes('spacer') ||
      lower.includes('blank.gif') ||
      lower.includes('transparent.png') ||
      lower.includes('no-image') ||
      lower.includes('noimage') ||
      lower.includes('loading.gif') ||
      lower.includes('loader.')
    ) return true;
    // Very small base64 images are likely placeholders / LQIP / spinners
    if (lower.startsWith('data:image') && src.length < 2000) return true;
    return false;
  }

  /**
   * Get the best real image src from an <img>, trying multiple attributes.
   * Priority:
   *   1. currentSrc (browser-resolved, best quality in responsive images)
   *   2. src (if not a placeholder)
   *   3. data-src / data-lazy-src / data-original / etc. (lazy-load)
   *   4. srcset / data-srcset best candidate
   */
  function getImgSrc(img) {
    // 1. Use currentSrc if available (browser already picked best srcset src)
    if (img.currentSrc && !isPlaceholderSrc(img.currentSrc)) {
      return resolveUrl(img.currentSrc);
    }

    // 2. Use src if not a placeholder
    const src = img.getAttribute('src');
    if (src && !isPlaceholderSrc(src) && !src.startsWith('data:')) {
      return resolveUrl(src);
    }

    // 3. Lazy-load data attributes
    const lazyAttrs = [
      'data-src',
      'data-lazy-src',
      'data-original',
      'data-url',
      'data-image',
      'data-img-src',
      'data-full-src',
      'data-echo',
      'data-lazy',
    ];
    for (const attr of lazyAttrs) {
      const val = img.getAttribute(attr);
      if (val && !isPlaceholderSrc(val)) {
        return resolveUrl(val);
      }
    }

    // 4. Parse srcset / data-srcset and pick highest resolution
    for (const attr of ['srcset', 'data-srcset']) {
      const setVal = img.getAttribute(attr);
      if (setVal) {
        const best = parseSrcset(setVal);
        if (best && !isPlaceholderSrc(best)) return resolveUrl(best);
      }
    }

    // 5. Fallback: accept src even if it might be placeholder (last resort)
    if (src && !src.startsWith('data:')) return resolveUrl(src);
    if (img.src && !img.src.startsWith('data:')) return resolveUrl(img.src);

    return '';
  }

  /** Parse srcset string and return highest-resolution URL. */
  function parseSrcset(srcset) {
    if (!srcset) return '';
    let bestUrl = '';
    let bestW = 0;
    const parts = srcset.split(',').map(s => s.trim());
    for (const part of parts) {
      const segments = part.trim().split(/\s+/);
      const url = segments[0];
      const descriptor = segments[1] || '';
      const w = descriptor.endsWith('w') ? parseInt(descriptor) : (descriptor.endsWith('x') ? parseFloat(descriptor) * 1000 : 0);
      if (!url) continue;
      if (w > bestW) {
        bestW = w;
        bestUrl = url;
      } else if (!bestUrl) {
        bestUrl = url;
      }
    }
    return bestUrl;
  }

  /**
   * Extract a real image URL from a CSS background-image property.
   * Returns '' if none found.
   */
  function getCssBackgroundImage(el) {
    const style = window.getComputedStyle(el);
    const bg = style.backgroundImage;
    if (!bg || bg === 'none') return '';
    const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
    if (!match) return '';
    const url = match[1].trim();
    if (isPlaceholderSrc(url)) return '';
    return resolveUrl(url);
  }

  // =====================================================================
  // CONTENT DETECTION
  // =====================================================================

  function detectContentElement() {
    // 0. Priority selectors (highly specific)
    const prioritySelectors = [
      '.elementor-widget-theme-post-content .elementor-widget-container',
      '.elementor-widget-theme-post-content',
      '.entry-content',
      '.post-content',
      '.article-body',
      'article.post',
      '.article-content',
      '.post-body',
      '[itemprop="articleBody"]',
    ];

    for (const sel of prioritySelectors) {
      const found = document.querySelector(sel);
      if (found && found.textContent.trim().length > 200) {
        return found;
      }
    }

    // 1. Scoring-based detection
    const candidates = [
      'article', '[role="main"]', 'main',
      '.post-content', '.entry-content', '.content-body', '.article-content',
      '.blog-post', '.single-post', '.page-content',
      '#content', '#main', '.main', '.content',
    ];

    let best = null;
    let maxScore = 0;

    for (const sel of candidates) {
      for (const el of document.querySelectorAll(sel)) {
        const textLen = el.textContent.trim().length;
        const pCount = el.querySelectorAll('p').length;
        const imgCount = el.querySelectorAll('img').length;
        if (textLen < 200) continue;

        let score = textLen + pCount * 80 + imgCount * 50;
        if (el.tagName.toLowerCase() === 'article') score += 1500;

        if (score > maxScore) { maxScore = score; best = el; }
      }
    }

    if (best) return best;

    // 2. Broad scan with penalty for noisy containers
    const noisyClasses = ['sidebar', 'comment', 'footer', 'header', 'nav', 'widget', 'toc', 'ad'];
    for (const el of document.body.querySelectorAll('div, section, article, main')) {
      if (el.offsetParent === null) continue; // hidden
      const textLen = el.textContent.trim().length;
      if (textLen < 300) continue;

      const cls = (el.className?.toString() + ' ' + (el.id || '')).toLowerCase();
      const isNoisy = noisyClasses.some(c => cls.includes(c));
      if (isNoisy) continue;

      const pCount = el.querySelectorAll('p').length;
      const score = textLen + pCount * 50;
      if (score > maxScore) { maxScore = score; best = el; }
    }

    return best || document.body;
  }

  // =====================================================================
  // HTML TO MARKDOWN CONVERSION
  // =====================================================================

  function htmlToMarkdown(element, ctx) {
    if (!element) return '';
    let result = '';

    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        let text = node.textContent;
        // Collapse whitespace but keep single spaces
        text = text.replace(/[ \t\r\n]+/g, ' ');
        result += text;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        result += processElement(node, ctx);
      }
    }
    return result;
  }

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'iframe', 'svg',
    'nav', 'footer', 'aside', 'button', 'input',
    'select', 'textarea', 'form', 'meta', 'link', 'head',
  ]);

  const NOISY_CLASSES = [
    'sidebar', 'related', 'comments', 'comment-section', 'social-share',
    'advertisement', 'google-ad', 'widget', 'popup', 'modal', 'newsletter',
    'subscription', 'signup', 'cookie', 'breadcrumb', 'pagination',
    'tag-cloud', 'toc', 'table-of-contents',
  ];

  function processElement(el, ctx) {
    const tag = el.tagName.toLowerCase();

    // Skip non-content tags
    if (SKIP_TAGS.has(tag)) return '';

    // Skip hidden elements
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return '';

    // Skip noisy class containers (but only if they have very little text)
    const cls = (el.className?.toString() || '').toLowerCase();
    const id = (el.id || '').toLowerCase();
    const combined = cls + ' ' + id;
    const isNoisy = NOISY_CLASSES.some(c => combined.includes(c));

    if (isNoisy) {
      const hasImg = el.querySelector('img');
      if (el.textContent.trim().length < 100 && !hasImg) return '';
    }

    switch (tag) {
      // ---- Headings ----
      case 'h1': return `\n\n# ${htmlToMarkdown(el, ctx).trim()}\n\n`;
      case 'h2': return `\n\n## ${htmlToMarkdown(el, ctx).trim()}\n\n`;
      case 'h3': return `\n\n### ${htmlToMarkdown(el, ctx).trim()}\n\n`;
      case 'h4': return `\n\n#### ${htmlToMarkdown(el, ctx).trim()}\n\n`;
      case 'h5': return `\n\n##### ${htmlToMarkdown(el, ctx).trim()}\n\n`;
      case 'h6': return `\n\n###### ${htmlToMarkdown(el, ctx).trim()}\n\n`;

      // ---- Text formatting ----
      case 'strong':
      case 'b': {
        const inner = htmlToMarkdown(el, ctx).trim();
        return inner ? `**${inner}**` : '';
      }
      case 'em':
      case 'i': {
        const inner = htmlToMarkdown(el, ctx).trim();
        return inner ? `*${inner}*` : '';
      }
      case 'u': {
        const inner = htmlToMarkdown(el, ctx).trim();
        return inner ? `<u>${inner}</u>` : '';
      }
      case 's':
      case 'del':
      case 'strike': {
        const inner = htmlToMarkdown(el, ctx).trim();
        return inner ? `~~${inner}~~` : '';
      }
      case 'mark': {
        const inner = htmlToMarkdown(el, ctx).trim();
        return inner ? `==${inner}==` : '';
      }
      case 'sup': {
        const inner = htmlToMarkdown(el, ctx).trim();
        return inner ? `<sup>${inner}</sup>` : '';
      }
      case 'sub': {
        const inner = htmlToMarkdown(el, ctx).trim();
        return inner ? `<sub>${inner}</sub>` : '';
      }
      case 'abbr': {
        const inner = htmlToMarkdown(el, ctx).trim();
        const title = el.getAttribute('title');
        return title ? `${inner} (${title})` : inner;
      }

      // ---- Paragraphs / Blocks ----
      case 'p': {
        const inner = htmlToMarkdown(el, ctx).trim();
        return inner ? `\n\n${inner}\n\n` : '';
      }
      case 'br': return '\n';
      case 'hr': return '\n\n---\n\n';

      // ---- Links ----
      case 'a': {
        if (!ctx.includeLinks) return htmlToMarkdown(el, ctx);
        const href = el.getAttribute('href');
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
          return htmlToMarkdown(el, ctx);
        }
        const full = resolveUrl(href);
        const safe = safeMarkdownUrl(full);
        const inner = htmlToMarkdown(el, ctx).trim();
        const text = inner || full;
        ctx.linkCount++;

        // If contains only image, render image directly
        if (!inner && el.querySelector('img')) {
          return processElement(el.querySelector('img'), ctx);
        }
        return `[${text}](${safe})`;
      }

      // ---- Images ----
      case 'img': {
        if (!ctx.includeImages) return '';
        const src = getImgSrc(el);
        if (!src) return '';
        const safe = safeMarkdownUrl(src);
        const alt = (el.getAttribute('alt') || el.getAttribute('title') || 'image').trim();
        ctx.imageCount++;
        return `\n\n![${alt}](${safe})\n\n`;
      }

      // ---- Picture element ----
      case 'picture': {
        if (!ctx.includeImages) return '';
        const img = el.querySelector('img');
        if (img) return processElement(img, ctx);
        // Try <source>
        const source = el.querySelector('source');
        if (source) {
          const srcset = source.getAttribute('srcset') || source.getAttribute('data-srcset');
          if (srcset) {
            const best = parseSrcset(srcset);
            if (best) {
              const safe = safeMarkdownUrl(resolveUrl(best));
              ctx.imageCount++;
              return `\n\n![image](${safe})\n\n`;
            }
          }
        }
        return '';
      }

      // ---- Figure ----
      case 'figure': {
        if (!ctx.includeImages) return htmlToMarkdown(el, ctx);
        const img = el.querySelector('img');
        const caption = el.querySelector('figcaption');
        const captionText = caption?.textContent?.trim() || '';

        if (img) {
          const src = getImgSrc(img);
          if (src) {
            const safe = safeMarkdownUrl(src);
            const alt = captionText || img.getAttribute('alt') || 'image';
            ctx.imageCount++;
            const result = `\n\n![${alt}](${safe})\n\n`;
            return captionText ? result + `*${captionText}*\n\n` : result;
          }
        }

        // Might be a div-based figure with CSS background image
        const bgSrc = getCssBackgroundImage(el);
        if (bgSrc) {
          const safe = safeMarkdownUrl(bgSrc);
          ctx.imageCount++;
          return `\n\n![image](${safe})\n\n`;
        }

        return htmlToMarkdown(el, ctx);
      }

      // ---- Video ----
      case 'video': {
        const src = el.getAttribute('src') || el.querySelector('source')?.getAttribute('src') || '';
        if (!src) return '';
        return `\n\n<video src="${resolveUrl(src)}" controls style="max-width:100%"></video>\n\n`;
      }

      // ---- Lists ----
      case 'ul': return '\n\n' + processListItems(el, ctx, 'ul', 0) + '\n';
      case 'ol': return '\n\n' + processListItems(el, ctx, 'ol', 0) + '\n';
      case 'li': return htmlToMarkdown(el, ctx); // handled by processListItems

      // ---- Blockquote ----
      case 'blockquote': {
        const inner = htmlToMarkdown(el, ctx).trim();
        const lines = inner.split('\n');
        return '\n\n' + lines.map(l => `> ${l}`).join('\n') + '\n\n';
      }

      // ---- Code ----
      case 'code': {
        if (el.parentElement?.tagName.toLowerCase() === 'pre') {
          return el.textContent; // handled by pre
        }
        const inner = el.textContent.trim();
        return inner ? `\`${inner}\`` : '';
      }
      case 'pre': {
        const codeEl = el.querySelector('code');
        const code = codeEl ? codeEl.textContent : el.textContent;
        const lang = codeEl?.className?.match(/language-(\w+)/)?.[1] || '';
        return `\n\n\`\`\`${lang}\n${code.trim()}\n\`\`\`\n\n`;
      }
      case 'kbd': {
        return `\`${el.textContent.trim()}\``;
      }

      // ---- Tables ----
      case 'table': {
        if (!ctx.includeTables) return htmlToMarkdown(el, ctx);
        return processTable(el, ctx);
      }
      case 'thead':
      case 'tbody':
      case 'tfoot':
      case 'tr':
      case 'td':
      case 'th': return htmlToMarkdown(el, ctx);

      // ---- Definition Lists ----
      case 'dl': return '\n\n' + htmlToMarkdown(el, ctx) + '\n\n';
      case 'dt': return `\n**${htmlToMarkdown(el, ctx).trim()}**\n`;
      case 'dd': return `: ${htmlToMarkdown(el, ctx).trim()}\n`;

      // ---- Details/Summary ----
      case 'details': {
        const summary = el.querySelector('summary');
        const summaryText = summary?.textContent?.trim() || 'Details';
        const detailContent = [...el.childNodes]
          .filter(n => n !== summary)
          .map(n => n.nodeType === Node.ELEMENT_NODE ? processElement(n, ctx) : n.textContent)
          .join('')
          .trim();
        return `\n\n**${summaryText}**\n\n${detailContent}\n\n`;
      }
      case 'summary': return ''; // handled by details

      // ---- Divs and containers ----
      case 'div':
      case 'section':
      case 'article':
      case 'main':
      case 'header': {
        // Check if this div has a background image but no <img> children
        const inner = htmlToMarkdown(el, ctx);
        if (ctx.includeImages && !el.querySelector('img') && !el.querySelector('picture')) {
          const bgSrc = getCssBackgroundImage(el);
          if (bgSrc) {
            const safe = safeMarkdownUrl(bgSrc);
            ctx.imageCount++;
            return `\n\n![image](${safe})\n\n` + inner;
          }
        }
        return inner;
      }

      case 'span': return htmlToMarkdown(el, ctx);

      default:
        return htmlToMarkdown(el, ctx);
    }
  }

  function processListItems(listEl, ctx, type, depth) {
    let result = '';
    const indent = '  '.repeat(depth);
    let counter = 1;

    for (const child of listEl.children) {
      const childTag = child.tagName.toLowerCase();
      if (childTag !== 'li') continue;

      const prefix = type === 'ol' ? `${counter}. ` : '- ';

      // Collect direct content, excluding nested ul/ol
      let itemText = '';
      for (const node of child.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          itemText += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const t = node.tagName.toLowerCase();
          if (t !== 'ul' && t !== 'ol') {
            itemText += processElement(node, ctx);
          }
        }
      }
      itemText = itemText.trim();

      result += `${indent}${prefix}${itemText}\n`;

      // Nested lists
      const nestedUl = child.querySelector(':scope > ul');
      const nestedOl = child.querySelector(':scope > ol');
      if (nestedUl) result += processListItems(nestedUl, ctx, 'ul', depth + 1);
      if (nestedOl) result += processListItems(nestedOl, ctx, 'ol', depth + 1);

      counter++;
    }
    return result;
  }

  function processTable(tableEl, ctx) {
    let headerRow = [];
    const rows = [];
    let hasHeader = false;

    const thead = tableEl.querySelector('thead');
    if (thead) {
      const cells = thead.querySelectorAll('th, td');
      cells.forEach(cell => headerRow.push(htmlToMarkdown(cell, ctx).trim().replace(/\|/g, '\\|').replace(/\n/g, ' ')));
      hasHeader = true;
    }

    (tableEl.querySelectorAll('tbody tr, tr')).forEach((tr, idx) => {
      const cells = tr.querySelectorAll('td, th');
      const row = [];
      cells.forEach(c => row.push(htmlToMarkdown(c, ctx).trim().replace(/\|/g, '\\|').replace(/\n/g, ' ')));

      if (!hasHeader && idx === 0 && tr.querySelector('th')) {
        headerRow = row;
        hasHeader = true;
      } else if (hasHeader || idx > 0) {
        rows.push(row);
      } else {
        rows.push(row);
      }
    });

    if (!hasHeader && rows.length > 0) {
      headerRow = rows.shift();
    }

    if (headerRow.length === 0) return '';

    let table = '\n\n';
    table += '| ' + headerRow.join(' | ') + ' |\n';
    table += '| ' + headerRow.map(() => '---').join(' | ') + ' |\n';
    rows.forEach(row => {
      while (row.length < headerRow.length) row.push('');
      table += '| ' + row.join(' | ') + ' |\n';
    });
    table += '\n\n';
    return table;
  }

  // =====================================================================
  // MAIN EXTRACT FUNCTION
  // =====================================================================

  function extractContent(options = {}, targetElement = null) {
    const {
      includeImages = true,
      includeLinks = true,
      includeTables = true,
      includeFrontmatter = true,
    } = options;

    const contentEl = targetElement || detectContentElement();

    // Metadata
    const pageTitle =
      document.querySelector('h1')?.textContent?.trim() ||
      document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
      document.title || 'Untitled';

    const pageDescription =
      document.querySelector('meta[name="description"]')?.getAttribute('content') ||
      document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';

    // Cover image: prefer og:image then first real img in content
    let coverImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
    if (!coverImage) {
      const firstImg = contentEl.querySelector('img');
      if (firstImg) coverImage = getImgSrc(firstImg);
    }
    if (coverImage) coverImage = resolveUrl(coverImage);

    const pageUrl = window.location.href;

    const ctx = {
      includeImages,
      includeLinks,
      includeTables,
      imageCount: 0,
      linkCount: 0,
    };

    let markdown = htmlToMarkdown(contentEl, ctx).trim();

    // Cleanup: remove excessive blank lines, trailing spaces, etc.
    markdown = markdown
      .replace(/\n{4,}/g, '\n\n\n')  // max 3 consecutive newlines
      .replace(/[ \t]+$/gm, '')       // trailing spaces
      .replace(/^\s+$/gm, '')         // lines with only whitespace
      .trim();

    let result = '';
    if (includeFrontmatter) {
      result += '---\n';
      result += `title: "${pageTitle.replace(/"/g, '\\"')}"\n`;
      if (coverImage) result += `cover_image: ${coverImage}\n`;
      result += `category: Chia sẻ\n`;
      result += `tags: []\n`;
      result += `author: Shop Deals\n`;
      result += `published: true\n`;
      if (pageDescription) {
        const safeExcerpt = pageDescription.slice(0, 250).replace(/"/g, '\\"');
        result += `excerpt: "${safeExcerpt}"\n`;
      }
      result += `date: ${new Date().toISOString().split('T')[0]}\n`;
      result += '---\n\n';
    }

    result += markdown;

    return {
      markdown: result,
      title: pageTitle,
      url: pageUrl,
      imageCount: ctx.imageCount,
      linkCount: ctx.linkCount,
      charCount: result.length,
    };
  }

  // =====================================================================
  // SELECTION MODE
  // =====================================================================

  let selectionOverlay = null;
  let selectionHighlight = null;
  let selectionLabel = null;

  function startSelectionMode() {
    cleanupSelection();

    // Overlay to capture mouse events
    selectionOverlay = document.createElement('div');
    selectionOverlay.id = '__extractor_overlay__';
    selectionOverlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483646;cursor:crosshair;';
    document.body.appendChild(selectionOverlay);

    // Highlight box
    selectionHighlight = document.createElement('div');
    selectionHighlight.style.cssText =
      'position:fixed;z-index:2147483647;border:2px solid #7c3aed;' +
      'background:rgba(124,58,237,0.08);border-radius:4px;pointer-events:none;' +
      'transition:all 0.08s ease;display:none;box-shadow:0 0 0 1px rgba(124,58,237,0.3);';
    document.body.appendChild(selectionHighlight);

    // Info label
    selectionLabel = document.createElement('div');
    selectionLabel.style.cssText =
      'position:fixed;z-index:2147483647;bottom:16px;left:50%;transform:translateX(-50%);' +
      'background:#1e293b;color:#fff;padding:8px 20px;border-radius:100px;font-size:13px;' +
      'pointer-events:none;font-family:sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
    selectionLabel.textContent = '🖱 Click để chọn vùng nội dung • Esc để hủy';
    document.body.appendChild(selectionLabel);

    selectionOverlay.addEventListener('mousemove', handleSelectionMove);
    selectionOverlay.addEventListener('click', handleSelectionClick);
    document.addEventListener('keydown', handleSelectionEscape);
  }

  function handleSelectionMove(e) {
    selectionOverlay.style.pointerEvents = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    selectionOverlay.style.pointerEvents = 'auto';

    if (el && el !== document.body && el !== document.documentElement) {
      const rect = el.getBoundingClientRect();
      selectionHighlight.style.cssText +=
        `;display:block;left:${rect.left + window.scrollX}px;` +
        `top:${rect.top + window.scrollY}px;width:${rect.width}px;height:${rect.height}px;`;
      // Override position to use fixed (accounts for scroll)
      selectionHighlight.style.position = 'fixed';
      selectionHighlight.style.left = rect.left + 'px';
      selectionHighlight.style.top = rect.top + 'px';
      selectionHighlight.style.width = rect.width + 'px';
      selectionHighlight.style.height = rect.height + 'px';
      selectionHighlight.style.display = 'block';
      selectionOverlay._currentEl = el;
    }
  }

  function handleSelectionClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = selectionOverlay._currentEl;
    cleanupSelection();

    if (!el) {
      window.__extractorResult = { cancelled: true };
      return;
    }

    // Walk up if element too small
    let target = el;
    while (
      target &&
      target.textContent.trim().length < 30 &&
      target.parentElement &&
      target.parentElement !== document.body
    ) {
      target = target.parentElement;
    }

    const options = window.__extractorOptions || {};
    const ctx = {
      includeImages: options.includeImages !== false,
      includeLinks: options.includeLinks !== false,
      includeTables: options.includeTables !== false,
      imageCount: 0,
      linkCount: 0,
    };

    let markdown = htmlToMarkdown(target, ctx).trim();
    markdown = markdown.replace(/\n{4,}/g, '\n\n\n').replace(/[ \t]+$/gm, '').trim();

    let finalResult = '';
    if (options.includeFrontmatter !== false) {
      const pageTitle =
        target.querySelector('h1')?.textContent?.trim() ||
        document.querySelector('h1')?.textContent?.trim() ||
        document.title;
      const coverImage =
        document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
        (() => { const img = target.querySelector('img'); return img ? getImgSrc(img) : ''; })() ||
        '';

      finalResult += '---\n';
      finalResult += `title: "${pageTitle.replace(/"/g, '\\"')}"\n`;
      if (coverImage) finalResult += `cover_image: ${resolveUrl(coverImage)}\n`;
      finalResult += `category: Chia sẻ\n`;
      finalResult += `tags: []\n`;
      finalResult += `author: Shop Deals\n`;
      finalResult += `published: true\n`;
      finalResult += `date: ${new Date().toISOString().split('T')[0]}\n`;
      finalResult += '---\n\n';
    }
    finalResult += markdown;

    window.__extractorResult = {
      markdown: finalResult,
      title: document.title,
      url: window.location.href,
      imageCount: ctx.imageCount,
      linkCount: ctx.linkCount,
      charCount: finalResult.length,
    };
  }

  function handleSelectionEscape(e) {
    if (e.key === 'Escape') {
      cleanupSelection();
      window.__extractorResult = { cancelled: true };
    }
  }

  function cleanupSelection() {
    if (selectionOverlay) {
      selectionOverlay.removeEventListener('mousemove', handleSelectionMove);
      selectionOverlay.removeEventListener('click', handleSelectionClick);
      selectionOverlay.remove();
      selectionOverlay = null;
    }
    if (selectionHighlight) { selectionHighlight.remove(); selectionHighlight = null; }
    if (selectionLabel) { selectionLabel.remove(); selectionLabel = null; }
    document.removeEventListener('keydown', handleSelectionEscape);
  }

  // =====================================================================
  // EXPOSE
  // =====================================================================
  window.__extractContent = extractContent;
  window.__startSelectionMode = startSelectionMode;
})();
