import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
// @ts-ignore
import html2pdf from 'html2pdf.js';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';

export interface GeneratePdfOptions {
  container: HTMLElement;
  title: string;
  shortName?: string;
}

/**
 * Wait for web fonts and all images inside container to finish loading
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
            resolve();
          } else {
            img.onload = () => resolve();
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
 * Fallback PDF generator: Renders page-by-page using html2canvas (scale 1.5) and jsPDF
 */
async function generatePdfFallback(container: HTMLElement, filename: string): Promise<Blob> {
  const pdf = new jsPDF({
    unit: 'mm',
    format: 'a4',
    orientation: 'portrait',
  });

  const pdfWidthMm = 210;
  const pdfHeightMm = 297;
  const marginMm = 15;
  const printWidthMm = pdfWidthMm - marginMm * 2; // 180mm
  const printHeightMm = pdfHeightMm - marginMm * 2; // 267mm

  // Render canvas with scale 1.5 to prevent memory overflow
  const canvas = await html2canvas(container, {
    scale: 1.5,
    useCORS: true,
    backgroundColor: '#ffffff',
    windowWidth: 794,
  });

  const imgData = canvas.toDataURL('image/jpeg', 0.95);
  const imgWidthPx = canvas.width;
  const imgHeightPx = canvas.height;

  // Convert px to mm based on print width
  const totalHeightMm = (imgHeightPx * printWidthMm) / imgWidthPx;
  let heightLeftMm = totalHeightMm;
  let positionMm = marginMm;

  pdf.addImage(imgData, 'JPEG', marginMm, positionMm, printWidthMm, totalHeightMm, '', 'FAST');
  heightLeftMm -= printHeightMm;

  while (heightLeftMm > 0) {
    positionMm = marginMm - (totalHeightMm - heightLeftMm);
    pdf.addPage();
    pdf.addImage(imgData, 'JPEG', marginMm, positionMm, printWidthMm, totalHeightMm, '', 'FAST');
    heightLeftMm -= printHeightMm;
  }

  return pdf.output('blob');
}

/**
 * Generate and Save/Share PDF
 * - Uses html2pdf with margin 15mm, scale 2, portrait A4
 * - Automatic page-by-page fallback with scale 1.5 if memory or generation error occurs
 * - Shares via Capacitor Share on Android
 * - Direct download on browser
 */
export async function generateAndSharePdf(options: GeneratePdfOptions): Promise<void> {
  const { container, title, shortName } = options;
  const fileName = `${shortName || 'qb-question-paper'}.pdf`;

  // 1. Wait for fonts and images
  await waitForFontsAndImages(container);

  let pdfBlob: Blob;

  // 2. Try primary html2pdf.js generation
  try {
    const opt = {
      margin: 15, // 15mm
      filename: fileName,
      image: { type: 'jpeg' as const, quality: 0.98 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff',
        windowWidth: 794,
      },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' as const },
      pagebreak: { mode: ['css', 'legacy'] },
    };

    const worker = html2pdf().set(opt).from(container);
    pdfBlob = await worker.output('blob');
  } catch (primaryErr: any) {
    console.warn('Primary html2pdf failed, attempting page-by-page fallback:', primaryErr);
    // Automatic fallback with scale 1.5
    try {
      pdfBlob = await generatePdfFallback(container, fileName);
    } catch (fallbackErr: any) {
      console.error('Fallback PDF generation failed:', fallbackErr);
      throw new Error(
        `PDF তৈরিতে সমস্যা: ${primaryErr?.message || fallbackErr?.message || 'অজানা ত্রুটি'}`
      );
    }
  }

  // 3. Deliver PDF to user
  if (Capacitor.isNativePlatform()) {
    try {
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
        title: title || 'প্রশ্নপত্র',
        url: uriResult.uri,
        dialogTitle: 'PDF সেভ/শেয়ার',
      });
    } catch (shareErr: any) {
      console.error('Failed to share/save native PDF:', shareErr);
      throw new Error(`PDF ফাইল সংরক্ষণ/শেয়ারে ব্যর্থ: ${shareErr.message || 'অজানা ত্রুটি'}`);
    }
  } else {
    // Browser environment: trigger direct download
    try {
      const url = URL.createObjectURL(pdfBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (dlErr: any) {
      console.error('Browser download failed:', dlErr);
      throw new Error(`ব্রাউজার ডাউনলোড ব্যর্থ: ${dlErr.message || 'অজানা ত্রুটি'}`);
    }
  }
}
