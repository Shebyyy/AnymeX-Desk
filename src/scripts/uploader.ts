/**
 * uploader.ts — client-side drag-and-drop file uploader for the /new form.
 *
 * Progressively enhances the hidden file input into a proper drop zone.
 * After the report is created (server POST returns a redirect + Location header
 * via a fetch() call), it uploads each pending file to /upload?reportId=N and
 * then navigates to the report page.
 *
 * This script runs as a client-side island; import it with `is:inline` or via
 * an Astro <script> tag in new.astro.
 */

export interface UploadState {
  files: File[];
  reportId: number | null;
  error: string | null;
}

/** Extract report ID from a redirect URL like /report/42?filed */
function extractReportId(url: string): number | null {
  const m = url.match(/\/report\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Format bytes as a short human-readable string. */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One entry in the upload queue UI. */
function renderFileItem(file: File, status: 'pending' | 'uploading' | 'done' | 'error', msg?: string): HTMLElement {
  const li = document.createElement('li');
  li.className = `upload-item upload-${status}`;
  li.dataset.name = file.name;
  li.innerHTML = `
    <span class="upload-name">${escHtml(file.name)}</span>
    <span class="upload-size">${fmtSize(file.size)}</span>
    <span class="upload-status">${status === 'uploading' ? '↑ uploading…' : status === 'done' ? '✓' : status === 'error' ? `✗ ${escHtml(msg ?? 'failed')}` : ''}</span>
    <button type="button" class="upload-remove" aria-label="Remove ${escHtml(file.name)}" ${status === 'uploading' ? 'disabled' : ''}>×</button>
  `;
  return li;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Mount the uploader on a container element.
 * @param container  The drop-zone div element.
 * @param fileInput  The hidden <input type="file"> element.
 * @param listEl     The <ul> that shows the file queue.
 */
export function mountUploader(
  container: HTMLElement,
  fileInput: HTMLInputElement,
  listEl: HTMLUListElement,
) {
  const pending: File[] = [];

  function addFiles(incoming: FileList | File[]) {
    const arr = Array.from(incoming);
    for (const f of arr) {
      // Deduplicate by name+size
      if (pending.some((p) => p.name === f.name && p.size === f.size)) continue;
      pending.push(f);
      const li = renderFileItem(f, 'pending');
      li.querySelector('.upload-remove')?.addEventListener('click', () => {
        const idx = pending.findIndex((p) => p.name === f.name && p.size === f.size);
        if (idx !== -1) pending.splice(idx, 1);
        li.remove();
        updateDropLabel();
      });
      listEl.appendChild(li);
    }
    updateDropLabel();
  }

  function updateDropLabel() {
    const label = container.querySelector('.drop-label');
    if (label) {
      label.textContent = pending.length === 0
        ? 'Drop files here or click to browse'
        : `${pending.length} file${pending.length !== 1 ? 's' : ''} queued`;
    }
  }

  // Click to open file picker
  container.addEventListener('click', (e) => {
    if ((e.target as Element).closest('.upload-remove')) return;
    fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) addFiles(fileInput.files);
    fileInput.value = '';
  });

  // Drag & drop
  container.addEventListener('dragover', (e) => { e.preventDefault(); container.classList.add('drag-over'); });
  container.addEventListener('dragleave', () => container.classList.remove('drag-over'));
  container.addEventListener('drop', (e) => {
    e.preventDefault();
    container.classList.remove('drag-over');
    if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
  });

  /**
   * Upload all pending files to /upload for the given report.
   * Called after the form POST returns the new report ID.
   */
  async function uploadAll(reportId: number): Promise<void> {
    for (const f of pending) {
      const li = listEl.querySelector(`[data-name="${CSS.escape(f.name)}"]`) as HTMLElement | null;

      if (li) {
        li.className = 'upload-item upload-uploading';
        const s = li.querySelector('.upload-status');
        if (s) s.textContent = '↑ uploading…';
        const r = li.querySelector('.upload-remove') as HTMLButtonElement | null;
        if (r) r.disabled = true;
      }

      const fd = new FormData();
      fd.set('file', f);
      fd.set('reportId', String(reportId));

      try {
        const res = await fetch('/upload', { method: 'POST', body: fd });
        if (li) {
          if (res.ok) {
            li.className = 'upload-item upload-done';
            const s = li.querySelector('.upload-status');
            if (s) s.textContent = '✓';
          } else {
            const body = await res.json().catch(() => ({})) as { error?: string };
            li.className = 'upload-item upload-error';
            const s = li.querySelector('.upload-status');
            if (s) s.textContent = `✗ ${body.error ?? res.statusText}`;
          }
        }
      } catch (err) {
        if (li) {
          li.className = 'upload-item upload-error';
          const s = li.querySelector('.upload-status');
          if (s) s.textContent = `✗ network error`;
        }
      }
    }
  }

  return { pending, uploadAll };
}
