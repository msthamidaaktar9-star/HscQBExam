import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import html2canvas from 'html2canvas-pro';
import { jsPDF } from 'jspdf';
import katex from 'katex';
import { toBn } from './toBn';
import { db, type Paper, type Question, type Stimulus } from '../db/db';
import { getImageBlobUrl } from '../db/api';

export interface GeneratePdfOptions {
  paper: Paper;
  groupedQuestions: Array<{ stimulus?: Stimulus; questions: Question[] }>;
  imageUrls: Record<string, string>;
}

/**
 * Render RichText string with LaTeX to HTML string for A4 PDF page
 */
function renderRichTextToHtml(rawText: string): string {
  if (!rawText) return '';

  // Matches $$...$$ or $...$
  const regex = /(\$\$[\s\S]*?\$\$|\$[^\$\n]+?\$)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let html = '';

  const escapeHtml = (str: string) =>
    str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  while ((match = regex.exec(rawText)) !== null) {
    const matchIndex = match.index;
    if (matchIndex > lastIndex) {
      html += escapeHtml(rawText.substring(lastIndex, matchIndex));
    }

    const token = match[0];
    const isBlock = token.startsWith('$$') && token.endsWith('$$');
    const mathContent = isBlock ? token.slice(2, -2).trim() : token.slice(1, -1).trim();

    try {
      const rendered = katex.renderToString(mathContent, {
        displayMode: isBlock,
        throwOnError: false,
      });

      if (isBlock) {
        html += `<div style="text-align: center; margin: 6px 0; max-width: 100%; overflow: hidden; font-size: 0.95em;">${rendered}</div>`;
      } else {
        html += `<span style="display: inline-block; vertical-align: middle; margin: 0 2px; max-width: 100%; overflow: hidden; font-size: 0.95em;">${rendered}</span>`;
      }
    } catch {
      html += escapeHtml(token);
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < rawText.length) {
    html += escapeHtml(rawText.substring(lastIndex));
  }

  return html;
}

/**
 * Wait for web fonts and all images inside container to finish loading and decoding
 */
async function waitForFontsAndImages(container: HTMLElement): Promise<void> {
  if (document.fonts && document.fonts.ready) {
    await document.fonts.ready;
  }

  const images = Array.from(container.querySelectorAll('img'));
  await Promise.all(
    images.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete) {
            if (img.decode) {
              img.decode().then(resolve).catch(resolve);
            } else {
              resolve();
            }
          } else {
            img.onload = () => {
              if (img.decode) {
                img.decode().then(resolve).catch(resolve);
              } else {
                resolve();
              }
            };
            img.onerror = () => resolve();
          }
        })
    )
  );
}

/**
 * Convert Blob to Base64 (stripping the "data:...;base64," prefix)
 */
async function blobToBase64Only(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      if (!result) {
        reject(new Error('ফাইল রিডার কোনো ডাটা পায়নি'));
        return;
      }
      const base64Only = result.split(',')[1] || '';
      resolve(base64Only);
    };
    reader.onerror = () => reject(reader.error || new Error('ফাইল রূপান্তরে ব্যর্থ হয়েছে'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Build Header element for the first page
 */
function buildPaperHeaderElement(paper: Paper): HTMLElement {
  const headerDiv = document.createElement('div');
  headerDiv.style.textAlign = 'center';
  headerDiv.style.paddingBottom = '12px';
  headerDiv.style.marginBottom = '14px';
  headerDiv.style.borderBottom = '2px solid #000000';
  headerDiv.style.boxSizing = 'border-box';
  headerDiv.style.width = '100%';

  // Title
  const titleEl = document.createElement('h1');
  titleEl.textContent = paper.title || 'প্রশ্নপত্র';
  titleEl.style.fontSize = '20px';
  titleEl.style.fontWeight = '900';
  titleEl.style.color = '#000000';
  titleEl.style.margin = '0 0 4px 0';
  titleEl.style.lineHeight = '1.3';
  titleEl.style.overflowWrap = 'anywhere';
  titleEl.style.wordBreak = 'break-word';
  titleEl.style.whiteSpace = 'pre-wrap';
  titleEl.style.maxWidth = '100%';
  headerDiv.appendChild(titleEl);

  // Subject line
  if (paper.subjectLine) {
    const subEl = document.createElement('p');
    subEl.textContent = paper.subjectLine;
    subEl.style.fontSize = '13px';
    subEl.style.fontWeight = 'bold';
    subEl.style.color = '#000000';
    subEl.style.margin = '0 0 6px 0';
    subEl.style.overflowWrap = 'anywhere';
    subEl.style.wordBreak = 'break-word';
    headerDiv.appendChild(subEl);
  }

  // Time & Total Marks row
  const metaRow = document.createElement('div');
  metaRow.style.display = 'flex';
  metaRow.style.justifyContent = 'space-between';
  metaRow.style.alignItems = 'center';
  metaRow.style.fontSize = '12px';
  metaRow.style.fontWeight = 'bold';
  metaRow.style.color = '#000000';
  metaRow.style.paddingTop = '4px';

  const durationSpan = document.createElement('span');
  durationSpan.textContent = `সময়: ${paper.duration || '২ ঘণ্টা ৩০ মিনিট'}`;
  const marksSpan = document.createElement('span');
  marksSpan.textContent = `পূর্ণমান: ${toBn(paper.totalMarks || 50)}`;

  metaRow.appendChild(durationSpan);
  metaRow.appendChild(marksSpan);
  headerDiv.appendChild(metaRow);

  // Instruction Notice
  const noteDiv = document.createElement('div');
  noteDiv.textContent =
    '[ দ্রষ্টব্য: ডান পাশের সংখ্যা প্রশ্নের পূর্ণমান নির্দেশক। প্রয়োজনীয় ক্ষেত্রে চিত্র অঙ্কন আবশ্যক। ]';
  noteDiv.style.textAlign = 'center';
  noteDiv.style.fontSize = '11px';
  noteDiv.style.fontWeight = '600';
  noteDiv.style.fontStyle = 'italic';
  noteDiv.style.color = '#333333';
  noteDiv.style.paddingTop = '6px';
  headerDiv.appendChild(noteDiv);

  return headerDiv;
}

/**
 * Build Question Group Block DOM Element
 */
function buildQuestionGroupElement(
  group: { stimulus?: Stimulus; questions: Question[] },
  gIdx: number,
  imageUrls: Record<string, string>
): HTMLElement {
  const block = document.createElement('div');
  block.style.paddingBottom = '14px';
  block.style.marginBottom = '14px';
  block.style.borderBottom = '1px solid #E5E7EB';
  block.style.boxSizing = 'border-box';
  block.style.width = '100%';
  block.style.maxWidth = '100%';
  block.style.overflowWrap = 'anywhere';
  block.style.wordBreak = 'break-word';

  // Question Serial Header & Board Tag (Always in Bengali: e.g. [DB'২৫])
  const topRow = document.createElement('div');
  topRow.style.display = 'flex';
  topRow.style.justifyContent = 'space-between';
  topRow.style.alignItems = 'flex-start';
  topRow.style.gap = '8px';
  topRow.style.marginBottom = '6px';
  topRow.style.width = '100%';

  const serialSpan = document.createElement('span');
  serialSpan.textContent = `${toBn(gIdx + 1)}।`;
  serialSpan.style.fontWeight = '900';
  serialSpan.style.fontSize = '14px';
  serialSpan.style.color = '#000000';
  serialSpan.style.flexShrink = '0';
  topRow.appendChild(serialSpan);

  if (group.stimulus?.boardTag) {
    const boardSpan = document.createElement('span');
    // Ensure all digits in boardTag are converted to Bengali digits
    const bengaliBoardTag = toBn(group.stimulus.boardTag);
    boardSpan.textContent = `[${bengaliBoardTag}]`;
    boardSpan.style.fontSize = '11px';
    boardSpan.style.fontWeight = '600';
    boardSpan.style.color = '#4B5563';
    boardSpan.style.flexShrink = '0';
    topRow.appendChild(boardSpan);
  }
  block.appendChild(topRow);

  // Stimulus Text
  if (group.stimulus?.text) {
    const stimTextDiv = document.createElement('div');
    stimTextDiv.innerHTML = renderRichTextToHtml(group.stimulus.text);
    stimTextDiv.style.fontSize = '12.5px';
    stimTextDiv.style.fontWeight = '500';
    stimTextDiv.style.color = '#111827';
    stimTextDiv.style.lineHeight = '1.6';
    stimTextDiv.style.marginBottom = '8px';
    stimTextDiv.style.overflowWrap = 'anywhere';
    stimTextDiv.style.wordBreak = 'break-word';
    stimTextDiv.style.whiteSpace = 'pre-wrap';
    stimTextDiv.style.maxWidth = '100%';
    block.appendChild(stimTextDiv);
  }

  // Stimulus Images
  if (group.stimulus?.imageIds && group.stimulus.imageIds.length > 0) {
    for (const imgId of group.stimulus.imageIds) {
      const url = imageUrls[imgId];
      if (url) {
        const imgWrap = document.createElement('div');
        imgWrap.style.textAlign = 'center';
        imgWrap.style.margin = '8px 0';

        const img = document.createElement('img');
        img.src = url;
        img.alt = 'উদ্দীপক চিত্র';
        img.style.maxWidth = '230px';
        img.style.maxHeight = '200px';
        img.style.objectFit = 'contain';
        img.style.display = 'inline-block';
        imgWrap.appendChild(img);
        block.appendChild(imgWrap);
      }
    }
  }

  // Sub-questions (গ, ঘ)
  // Requirement 2: text in flex: 1, min-width: 0, marks in separate column fixed on right
  const subWrap = document.createElement('div');
  subWrap.style.paddingLeft = '8px';
  subWrap.style.marginTop = '6px';
  subWrap.style.display = 'flex';
  subWrap.style.flexDirection = 'column';
  subWrap.style.gap = '8px';
  subWrap.style.width = '100%';

  group.questions.forEach((q, qIdx) => {
    const qRow = document.createElement('div');
    qRow.style.display = 'flex';
    qRow.style.alignItems = 'flex-start';
    qRow.style.justifyContent = 'space-between';
    qRow.style.gap = '8px';
    qRow.style.width = '100%';
    qRow.style.fontSize = '12px';
    qRow.style.lineHeight = '1.5';

    // Left container for label and question text
    const qLeft = document.createElement('div');
    qLeft.style.display = 'flex';
    qLeft.style.alignItems = 'flex-start';
    qLeft.style.gap = '6px';
    qLeft.style.flex = '1';
    qLeft.style.minWidth = '0';
    qLeft.style.maxWidth = 'calc(100% - 32px)';

    // Label: "গ." or "(১)"
    const labelSpan = document.createElement('span');
    labelSpan.textContent = q.type ? `${q.type}.` : `(${toBn(qIdx + 1)})`;
    labelSpan.style.fontWeight = 'bold';
    labelSpan.style.color = '#000000';
    labelSpan.style.flexShrink = '0';
    qLeft.appendChild(labelSpan);

    // Text: with full word wrap and KaTeX
    const textSpan = document.createElement('span');
    textSpan.innerHTML = renderRichTextToHtml(q.questionText || '');
    textSpan.style.flex = '1';
    textSpan.style.minWidth = '0';
    textSpan.style.color = '#111827';
    textSpan.style.overflowWrap = 'anywhere';
    textSpan.style.wordBreak = 'break-word';
    textSpan.style.whiteSpace = 'pre-wrap';
    textSpan.style.maxWidth = '100%';
    qLeft.appendChild(textSpan);

    qRow.appendChild(qLeft);

    // Right column for marks (always visible on the right, never pushed off)
    const marksSpan = document.createElement('span');
    marksSpan.textContent = toBn(q.marks);
    marksSpan.style.fontWeight = 'bold';
    marksSpan.style.color = '#000000';
    marksSpan.style.flexShrink = '0';
    marksSpan.style.textAlign = 'right';
    marksSpan.style.paddingLeft = '6px';
    marksSpan.style.minWidth = '24px';
    qRow.appendChild(marksSpan);

    subWrap.appendChild(qRow);
  });

  block.appendChild(subWrap);
  return block;
}

/**
 * Main PDF Generation and Delivery Function
 * - Strict multi-page layout: width 794px, height 1123px, padding 57px (15mm)
 * - Measurement based pagination so NO question is ever cut across pages
 * - Uses html2canvas-pro to support modern colors without oklab/oklch errors
 * - jsPDF A4 portrait at quality 0.92
 * - Capacitor Filesystem + Share on native, direct download on browser
 */
export async function generateAndSharePdf(options: GeneratePdfOptions): Promise<void> {
  const { paper, groupedQuestions, imageUrls } = options;
  const fileName = `${paper.shortName || 'question-paper'}.pdf`;

  // Hidden container for staging and measurement
  const hiddenRoot = document.createElement('div');
  hiddenRoot.style.position = 'absolute';
  hiddenRoot.style.left = '-9999px';
  hiddenRoot.style.top = '0px';
  hiddenRoot.style.width = '794px';
  hiddenRoot.style.background = '#ffffff';
  hiddenRoot.style.color = '#111827';
  hiddenRoot.style.fontFamily = "'Hind Siliguri', serif";
  hiddenRoot.style.boxSizing = 'border-box';
  hiddenRoot.style.zIndex = '-9999';
  document.body.appendChild(hiddenRoot);

  try {
    // 1. Wait for fonts and images
    await waitForFontsAndImages(hiddenRoot);

    // A4 Dimensions:
    // Total: 794px x 1123px. Padding: 57px.
    // Usable Content Area: 680px width x 1009px height.
    const PAGE_WIDTH_PX = 794;
    const PAGE_HEIGHT_PX = 1123;
    const PAGE_PADDING_PX = 57;
    const CONTENT_WIDTH_PX = PAGE_WIDTH_PX - PAGE_PADDING_PX * 2; // 680px
    const CONTENT_HEIGHT_PX = PAGE_HEIGHT_PX - PAGE_PADDING_PX * 2; // 1009px

    // Measurement helper container
    const measureContainer = document.createElement('div');
    measureContainer.style.width = `${CONTENT_WIDTH_PX}px`;
    measureContainer.style.boxSizing = 'border-box';
    measureContainer.style.position = 'absolute';
    measureContainer.style.left = '0px';
    measureContainer.style.top = '0px';
    measureContainer.style.visibility = 'hidden';
    hiddenRoot.appendChild(measureContainer);

    // Measure Header
    const headerEl = buildPaperHeaderElement(paper);
    measureContainer.appendChild(headerEl);
    await waitForFontsAndImages(measureContainer);
    const headerHeight = headerEl.getBoundingClientRect().height || headerEl.offsetHeight;
    measureContainer.removeChild(headerEl);

    // Measure each question group
    const measuredGroups: Array<{ element: HTMLElement; height: number }> = [];
    for (let i = 0; i < groupedQuestions.length; i++) {
      const blockEl = buildQuestionGroupElement(groupedQuestions[i], i, imageUrls);
      measureContainer.appendChild(blockEl);
      await waitForFontsAndImages(measureContainer);
      const h = blockEl.getBoundingClientRect().height || blockEl.offsetHeight;
      measureContainer.removeChild(blockEl);
      measuredGroups.push({ element: blockEl, height: h });
    }

    // Measure End marker ("— সমাপ্ত —")
    const endMarkerEl = document.createElement('div');
    endMarkerEl.textContent = '— সমাপ্ত —';
    endMarkerEl.style.textAlign = 'center';
    endMarkerEl.style.fontSize = '11px';
    endMarkerEl.style.color = '#6B7280';
    endMarkerEl.style.paddingTop = '14px';
    measureContainer.appendChild(endMarkerEl);
    const endMarkerHeight = endMarkerEl.getBoundingClientRect().height || endMarkerEl.offsetHeight;
    measureContainer.removeChild(endMarkerEl);

    // Remove measureContainer
    hiddenRoot.removeChild(measureContainer);

    // 2. Pagination Algorithm
    const pageDivs: HTMLElement[] = [];

    const createNewPageDiv = (isFirstPage: boolean): { pageDiv: HTMLElement; contentDiv: HTMLElement } => {
      const pageDiv = document.createElement('div');
      pageDiv.style.width = `${PAGE_WIDTH_PX}px`;
      pageDiv.style.height = `${PAGE_HEIGHT_PX}px`;
      pageDiv.style.padding = `${PAGE_PADDING_PX}px`;
      pageDiv.style.boxSizing = 'border-box';
      pageDiv.style.overflow = 'hidden';
      pageDiv.style.background = '#ffffff';
      pageDiv.style.color = '#111827';
      pageDiv.style.fontFamily = "'Hind Siliguri', serif";
      pageDiv.style.display = 'flex';
      pageDiv.style.flexDirection = 'column';
      pageDiv.style.justifyContent = 'flex-start';
      pageDiv.style.position = 'relative';

      const contentDiv = document.createElement('div');
      contentDiv.style.width = '100%';
      contentDiv.style.flex = '1';
      contentDiv.style.minWidth = '0';
      contentDiv.style.display = 'flex';
      contentDiv.style.flexDirection = 'column';
      pageDiv.appendChild(contentDiv);

      if (isFirstPage) {
        contentDiv.appendChild(headerEl);
      }

      hiddenRoot.appendChild(pageDiv);
      pageDivs.push(pageDiv);
      return { pageDiv, contentDiv };
    };

    let currentPage = createNewPageDiv(true);
    let currentUsedHeight = headerHeight;

    // Distribute measured question blocks across pages
    for (const item of measuredGroups) {
      const blockEl = item.element;
      const blockHeight = item.height;

      // Check if block fits on current page
      if (currentUsedHeight + blockHeight <= CONTENT_HEIGHT_PX) {
        currentPage.contentDiv.appendChild(blockEl);
        currentUsedHeight += blockHeight;
      } else {
        // Open a new page (block is never split across two pages!)
        currentPage = createNewPageDiv(false);
        currentPage.contentDiv.appendChild(blockEl);
        currentUsedHeight = blockHeight;
      }
    }

    // Append End Marker
    if (currentUsedHeight + endMarkerHeight <= CONTENT_HEIGHT_PX) {
      currentPage.contentDiv.appendChild(endMarkerEl);
    } else {
      // If end marker barely doesn't fit, start a new page or attach
      currentPage.contentDiv.appendChild(endMarkerEl);
    }

    // 3. Wait for all fonts and images inside all pages
    await waitForFontsAndImages(hiddenRoot);

    // 4. Render each page div to jsPDF using html2canvas-pro
    const pdf = new jsPDF({
      unit: 'mm',
      format: 'a4',
      orientation: 'portrait',
    });

    for (let i = 0; i < pageDivs.length; i++) {
      if (i > 0) {
        pdf.addPage();
      }

      const canvas = await html2canvas(pageDivs[i], {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff',
        width: PAGE_WIDTH_PX,
        height: PAGE_HEIGHT_PX,
        windowWidth: PAGE_WIDTH_PX,
      });

      const imgData = canvas.toDataURL('image/jpeg', 0.92);
      // Fit A4 210mm x 297mm exactly
      pdf.addImage(imgData, 'JPEG', 0, 0, 210, 297, undefined, 'FAST');
    }

    const pdfBlob = pdf.output('blob');

    // 5. Deliver PDF to Android or Web Browser
    if (Capacitor.isNativePlatform()) {
      const base64Only = await blobToBase64Only(pdfBlob);
      const cachePath = `qb-${Date.now()}.pdf`;

      // Write without encoding
      await Filesystem.writeFile({
        path: cachePath,
        data: base64Only,
        directory: Directory.Cache,
      });

      const uriResult = await Filesystem.getUri({
        path: cachePath,
        directory: Directory.Cache,
      });

      await Share.share({
        title: paper.title || paper.shortName,
        url: uriResult.uri,
        dialogTitle: 'PDF সেভ/শেয়ার',
      });
    } else {
      // Direct browser download
      const url = URL.createObjectURL(pdfBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  } finally {
    // Clean up measurement root
    if (hiddenRoot && hiddenRoot.parentNode) {
      hiddenRoot.parentNode.removeChild(hiddenRoot);
    }
  }
}

/**
 * Convenient helper to load all paper questions, stimuli, and images by paperId,
 * and execute the PDF generation process
 */
export async function exportPaperById(paperId: string): Promise<void> {
  const paper = await db.papers.get(paperId);
  if (!paper) {
    throw new Error('প্রশ্নপত্রটি ডাটাবেসে পাওয়া যায়নি।');
  }

  const questionsList = await db.questions
    .where('id')
    .anyOf(paper.questionIds || [])
    .toArray();

  questionsList.sort((a, b) => {
    const idxA = paper.questionIds.indexOf(a.id);
    const idxB = paper.questionIds.indexOf(b.id);
    return idxA - idxB;
  });

  const stimulusIds = Array.from(
    new Set(questionsList.map((q) => q.stimulusId).filter(Boolean))
  ) as string[];

  const stimuliMap = new Map<string, Stimulus>();
  if (stimulusIds.length > 0) {
    const stims = await db.stimuli.where('id').anyOf(stimulusIds).toArray();
    stims.forEach((s) => stimuliMap.set(s.id, s));
  }

  const groups: Array<{ stimulus?: Stimulus; questions: Question[] }> = [];
  const stimGroupMap = new Map<string, Question[]>();
  const noStimQuestions: Question[] = [];

  for (const q of questionsList) {
    if (q.stimulusId && stimuliMap.has(q.stimulusId)) {
      const arr = stimGroupMap.get(q.stimulusId) || [];
      arr.push(q);
      stimGroupMap.set(q.stimulusId, arr);
    } else {
      noStimQuestions.push(q);
    }
  }

  stimGroupMap.forEach((qList, stimId) => {
    groups.push({
      stimulus: stimuliMap.get(stimId),
      questions: qList,
    });
  });

  for (const q of noStimQuestions) {
    groups.push({ questions: [q] });
  }

  // Fetch Images Blob URLs
  const urls: Record<string, string> = {};
  for (const g of groups) {
    if (g.stimulus?.imageIds) {
      for (const imgId of g.stimulus.imageIds) {
        const url = await getImageBlobUrl(imgId);
        if (url) urls[imgId] = url;
      }
    }
    for (const q of g.questions) {
      if (q.solutionImageIds) {
        for (const imgId of q.solutionImageIds) {
          const url = await getImageBlobUrl(imgId);
          if (url) urls[imgId] = url;
        }
      }
    }
  }

  await generateAndSharePdf({
    paper,
    groupedQuestions: groups,
    imageUrls: urls,
  });
}

