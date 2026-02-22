/**
 * Blog Content Extractor - Popup Script v2.0
 * Includes AI processing via Gemini API (same config as affiliate shop chatbot).
 */
document.addEventListener('DOMContentLoaded', () => {
  // ── Elements ──
  const btnFullPage   = document.getElementById('btn-full-page');
  const btnSelection  = document.getElementById('btn-selection');
  const btnExtract    = document.getElementById('btn-extract');
  const btnCopy       = document.getElementById('btn-copy');
  const btnDownload   = document.getElementById('btn-download');
  const btnSettings   = document.getElementById('btn-settings');
  const btnSaveKey    = document.getElementById('btn-save-key');
  const settingsPanel = document.getElementById('settings-panel');
  const apiKeyInput   = document.getElementById('api-key-input');
  const resultSection = document.getElementById('result-section');
  const resultText    = document.getElementById('result-text');
  const statusEl      = document.getElementById('status');
  const selectionInfo = document.getElementById('selection-info');
  const statChars     = document.getElementById('stat-chars');
  const statImages    = document.getElementById('stat-images');
  const statLinks     = document.getElementById('stat-links');
  const aiPanel       = document.getElementById('ai-panel');
  const btnAiFull     = document.getElementById('btn-ai-full');
  const btnAiClean    = document.getElementById('btn-ai-clean');
  const aiStatusEl    = document.getElementById('ai-status');

  let mode = 'full'; // 'full' | 'selection'
  let extractedMarkdown = '';

  // ── Load saved API key ──
  chrome.storage.local.get('geminiApiKey', (data) => {
    if (data.geminiApiKey) {
      apiKeyInput.value = data.geminiApiKey;
    }
  });

  // ── Settings panel toggle ──
  btnSettings.addEventListener('click', () => {
    settingsPanel.classList.toggle('hidden');
  });

  btnSaveKey.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    if (!key) { showAiStatus('⚠️ Vui lòng nhập API key', 'error'); return; }
    chrome.storage.local.set({ geminiApiKey: key }, () => {
      showAiStatus('✅ Đã lưu API key!', 'success');
      setTimeout(() => settingsPanel.classList.add('hidden'), 1500);
    });
  });

  // ── Mode switching ──
  btnFullPage.addEventListener('click', () => {
    mode = 'full';
    btnFullPage.classList.add('active');
    btnSelection.classList.remove('active');
    selectionInfo.classList.add('hidden');
  });

  btnSelection.addEventListener('click', () => {
    mode = 'selection';
    btnSelection.classList.add('active');
    btnFullPage.classList.remove('active');
    selectionInfo.classList.remove('hidden');
  });

  // ── Options ──
  function getOptions() {
    return {
      includeImages:    document.getElementById('opt-images').checked,
      includeLinks:     document.getElementById('opt-links').checked,
      includeTables:    document.getElementById('opt-tables').checked,
      includeFrontmatter: document.getElementById('opt-frontmatter').checked,
    };
  }

  // ── Status helpers ──
  function showStatus(message, type = 'loading') {
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
    statusEl.classList.remove('hidden');
  }
  function hideStatus() { statusEl.classList.add('hidden'); }

  function showAiStatus(message, type = 'loading') {
    aiStatusEl.textContent = message;
    aiStatusEl.className = `ai-status ${type}`;
    aiStatusEl.classList.remove('hidden');
    if (type === 'success') setTimeout(() => aiStatusEl.classList.add('hidden'), 3000);
  }
  function hideAiStatus() { aiStatusEl.classList.add('hidden'); }

  // ── Extract button ──
  btnExtract.addEventListener('click', async () => {
    const options = getOptions();
    btnExtract.disabled = true;
    showStatus('⏳ Đang trích xuất nội dung...', 'loading');
    resultSection.classList.add('hidden');

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        showStatus('❌ Không tìm thấy tab', 'error');
        btnExtract.disabled = false;
        return;
      }

      if (mode === 'full') {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });

        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (opts) => window.__extractContent(opts),
          args: [options],
        });

        if (results?.[0]?.result) {
          displayResult(results[0].result);
        } else {
          showStatus('❌ Không thể trích xuất nội dung', 'error');
        }

      } else {
        // Selection mode
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });

        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (opts) => {
            window.__extractorOptions = opts;
            window.__extractorResult = null;
            window.__startSelectionMode();
          },
          args: [options],
        });

        showStatus('👆 Chọn vùng nội dung trên trang web...', 'loading');

        const pollInterval = setInterval(async () => {
          try {
            const checkResults = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => window.__extractorResult,
            });

            const result = checkResults?.[0]?.result;
            if (result) {
              clearInterval(pollInterval);
              btnExtract.disabled = false;
              if (result.cancelled) {
                showStatus('⚠️ Đã hủy chọn vùng', 'error');
                setTimeout(hideStatus, 2000);
              } else {
                displayResult(result);
              }
            }
          } catch {
            clearInterval(pollInterval);
            showStatus('❌ Lỗi khi chọn vùng', 'error');
            btnExtract.disabled = false;
          }
        }, 300);

        setTimeout(() => { clearInterval(pollInterval); btnExtract.disabled = false; }, 30000);
        return;
      }
    } catch (err) {
      showStatus(`❌ Lỗi: ${err.message}`, 'error');
    }

    btnExtract.disabled = false;
  });

  // ── Display result ──
  function displayResult(data) {
    extractedMarkdown = data.markdown;
    resultText.value = extractedMarkdown;
    resultSection.classList.remove('hidden');

    statChars.textContent  = `${data.charCount.toLocaleString()} ký tự`;
    statImages.textContent = `${data.imageCount} ảnh`;
    statLinks.textContent  = `${data.linkCount} link`;

    showStatus(`✅ Trích xuất thành công: "${data.title}"`, 'success');
    setTimeout(hideStatus, 3000);
  }

  // ── Copy button ──
  btnCopy.addEventListener('click', async () => {
    if (!extractedMarkdown) return;
    try {
      await navigator.clipboard.writeText(extractedMarkdown);
    } catch {
      resultText.select();
      document.execCommand('copy');
    }
    btnCopy.textContent = '✅ Đã copy!';
    btnCopy.classList.add('copied');
    setTimeout(() => { btnCopy.textContent = '📋 Copy'; btnCopy.classList.remove('copied'); }, 2000);
  });

  // ── Download button ──
  btnDownload.addEventListener('click', () => {
    if (!extractedMarkdown) return;
    const titleMatch = extractedMarkdown.match(/^title:\s*"?(.+?)"?\s*$/m);
    let filename = titleMatch ? titleMatch[1].trim() : 'blog-post';
    filename = filename
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim().replace(/\s+/g, '-').slice(0, 50);

    const blob = new Blob([extractedMarkdown], { type: 'text/markdown' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `${filename}.md`; a.click();
    URL.revokeObjectURL(url);
    btnDownload.textContent = '✅ Đã tải!';
    setTimeout(() => { btnDownload.textContent = '💾 Tải .md'; }, 2000);
  });

  // ── AI Processing ──────────────────────────────────────────────────────────

  const GEMINI_MODEL = 'gemma-3-27b-it';
  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  /**
   * Call Gemini API directly – same model/config as affiliate-shop chatbot.
   */
  async function callGemini(systemPrompt, userContent) {
    const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
    if (!geminiApiKey) {
      throw new Error('Chưa cấu hình API key. Nhấn ⚙️ để thêm API key Gemini.');
    }

    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: `${systemPrompt}\n\n---\n\n${userContent}` }],
        },
      ],
      generationConfig: {
        temperature: 0.55,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 8192,
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      ],
    };

    const res = await fetch(`${GEMINI_URL}?key=${geminiApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Lỗi Gemini API');

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('AI không trả về kết quả');
    return text;
  }

  // System prompts
  const SYSTEM_FULL = `
Bạn là một AI biên tập viên chuyên nghiệp cho website mua sắm affiliate "Shop Deals" – chuyên deal, mã giảm giá từ Shopee, TikTok Shop (Việt Nam).

NHIỆM VỤ của bạn gồm 3 bước BẮT BUỘC:

**BƯỚC 1 – DỌN DẸP (Clean)**
- Xoá hoàn toàn mọi đoạn điều hướng người đọc đến website/kênh khác như:
  • Link, nút CTA: "Theo dõi fanpage", "Tham gia group", "Xem thêm tại...", "Đăng ký kênh", v.v.
  • Thông tin liên hệ/mạng xã hội của trang nguồn: Facebook, Messenger, Zalo, TikTok, Instagram, YouTube của HỌ.
  • Phần "Tác giả", "Bài viết liên quan", sidebar, footer, cookie notice, popup text.
  • Quảng cáo, banner text, nội dung không liên quan đến chủ đề bài viết.
- GIỮ LẠI: Toàn bộ nội dung thông tin HỮU ÍCH (hướng dẫn, mẹo, review, so sánh, danh sách sản phẩm, hình ảnh, bảng dữ liệu).

**BƯỚC 2 – VIẾT LẠI (Rewrite)**
- Viết lại nội dung tự nhiên, mạch lạc hơn với giọng văn thân thiện, phù hợp độ tuổi 18-35.
- Tối ưu cấu trúc bài: dùng heading H2/H3 rõ ràng, bullet list khi liệt kê, bold từ khóa quan trọng.
- Giữ nguyên tất cả link sản phẩm Shopee/TikTok, hình ảnh (định dạng Markdown), bảng dữ liệu.
- Đảm bảo bài viết phù hợp SEO: tiêu đề rõ ràng, đoạn mở đầu hấp dẫn, kết bài có call-to-action nhẹ nhàng về shop.

**BƯỚC 3 – CẬP NHẬT FRONTMATTER**
- Cập nhật/điền đầy đủ phần frontmatter YAML (---) gồm:
  • title: (bổ sung, tối ưu SEO nếu cần)
  • category: (1 trong: "Mẹo mua sắm" / "Review" / "Hướng dẫn" / "Khuyến mãi" / "Xu hướng" / "Thời trang")
  • tags: danh sách 3-6 từ khóa liên quan, dạng: [tag1, tag2, tag3]
  • excerpt: tóm tắt hấp dẫn 1-2 câu (tối đa 200 ký tự)
  • Giữ nguyên: cover_image, author, published, date.
- Nếu không có frontmatter, hãy TẠO MỚI phần frontmatter đầy đủ.

**OUTPUT YÊU CẦU:**
- Trả về NGUYÊN VĂN Markdown hoàn chỉnh (bao gồm frontmatter YAML ở đầu)
- KHÔNG thêm lời giải thích, KHÔNG thêm tiêu đề "Kết quả:" hay bất kỳ chú thích nào
- Chỉ trả về nội dung Markdown thuần túy để copy-paste trực tiếp

Đây là nội dung cần xử lý:
`;

  const SYSTEM_CLEAN_ONLY = `
Bạn là AI biên tập cho website affiliate "Shop Deals". Thực hiện 2 việc:

**1. DỌN DẸP:** Xoá các phần:
- Điều hướng đến mạng xã hội/website của nguồn gốc (Facebook, Zalo, Messenger, Fanpage, Group của HỌ)
- CTA dẫn người dùng ra khỏi nội dung: "Xem thêm tại...", "Theo dõi kênh", "Đăng ký nhận tin"
- Nội dung sidebar, footer, tác giả, bài viết liên quan

**2. CẬP NHẬT FRONTMATTER:** Điền category chính xác và tags phù hợp:
- category: 1 trong: "Mẹo mua sắm" / "Review" / "Hướng dẫn" / "Khuyến mãi" / "Xu hướng" / "Thời trang"
- tags: 3-6 từ khóa dạng [tag1, tag2, tag3]
- excerpt: tóm tắt 1-2 câu nếu chưa có

**OUTPUT:** Chỉ trả về Markdown hoàn chỉnh, không thêm bất kỳ giải thích nào.

Nội dung cần xử lý:
`;

  async function runAI(mode) {
    if (!extractedMarkdown) {
      showAiStatus('⚠️ Chưa có nội dung để xử lý', 'error');
      return;
    }

    const systemPrompt = mode === 'full' ? SYSTEM_FULL : SYSTEM_CLEAN_ONLY;
    const label = mode === 'full' ? '🤖 Đang viết lại toàn bộ...' : '🧹 Đang dọn & phân loại...';

    btnAiFull.disabled  = true;
    btnAiClean.disabled = true;
    showAiStatus(label, 'loading');

    try {
      const result = await callGemini(systemPrompt, extractedMarkdown);
      // Trim wrapping ```markdown ``` if AI adds them
      const cleaned = result.replace(/^```(?:markdown)?\n?/, '').replace(/\n?```$/, '').trim();
      extractedMarkdown = cleaned;
      resultText.value  = cleaned;
      statChars.textContent = `${cleaned.length.toLocaleString()} ký tự`;
      showAiStatus('✅ AI đã xử lý xong! Kiểm tra và copy nội dung phía trên.', 'success');
    } catch (err) {
      showAiStatus(`❌ ${err.message}`, 'error');
    } finally {
      btnAiFull.disabled  = false;
      btnAiClean.disabled = false;
    }
  }

  btnAiFull.addEventListener('click',  () => runAI('full'));
  btnAiClean.addEventListener('click', () => runAI('clean'));
});
