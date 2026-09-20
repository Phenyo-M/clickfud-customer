/* ============================================================
   CLICKFUD — image uploads: client-side resize/compress,
   progress-tracked upload to Supabase Storage, and metadata
   tracking in the `images` table.
   ============================================================ */
window.App = window.App || {};

App.Upload = (function () {
  const BUCKET = 'images';
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB cap on the original file
  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const MAX_DIMENSION = 1600; // longest side, in px — never upscale
  const TARGET_MAX_BYTES = 1024 * 1024; // ~1MB ceiling for the optimized file
  const QUALITY_STEPS = [0.85, 0.75, 0.65]; // stop here even if still above target — never degrade further

  function supportsWebP() {
    const c = document.createElement('canvas');
    if (!c.getContext || !c.getContext('2d')) return false;
    return c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read this image file.')); };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Image encoding failed.')), type, quality);
    });
  }

  // Resizes (only if needed) and compresses toward TARGET_MAX_BYTES without
  // dropping below the last quality step — a smaller file always loses to a
  // readable one per the "image stays clear first" rule.
  async function optimizeImage(file) {
    const { img, url } = await loadImage(file);
    try {
      let { width, height } = img;
      const longest = Math.max(width, height);
      if (longest > MAX_DIMENSION) {
        const scale = MAX_DIMENSION / longest;
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, width, height);

      const useWebP = supportsWebP() && file.type !== 'image/png' /* keep PNG transparency as PNG */;
      const outType = useWebP ? 'image/webp' : (file.type === 'image/png' ? 'image/png' : 'image/jpeg');

      let blob = await canvasToBlob(canvas, outType, QUALITY_STEPS[0]);
      if (outType !== 'image/png') {
        for (let i = 1; i < QUALITY_STEPS.length && blob.size > TARGET_MAX_BYTES; i++) {
          blob = await canvasToBlob(canvas, outType, QUALITY_STEPS[i]);
        }
      }
      // Never let a "smaller" export exceed what we started with (tiny/simple images).
      if (blob.size >= file.size && file.type !== 'image/png') {
        blob = file;
      }
      return { blob, width, height, format: outType.split('/')[1], originalSize: file.size, optimizedSize: blob.size };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function extFor(format) { return format === 'jpeg' ? 'jpg' : format; }

  // Raw XHR (not the supabase-js client) so we get real upload progress.
  function uploadWithProgress(path, blob, contentType, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const url = `${App.CONFIG.SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURIComponent(path).replace(/%2F/g, '/')}`;
      xhr.open('POST', url, true);
      const token = (App.Store.state.session && App.Store.state.session.access_token) || App.CONFIG.SUPABASE_ANON_KEY;
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('apikey', App.CONFIG.SUPABASE_ANON_KEY);
      xhr.setRequestHeader('Content-Type', contentType);
      xhr.setRequestHeader('x-upsert', 'false');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`Upload failed (${xhr.status}). ${xhr.responseText || ''}`.trim()));
      };
      xhr.onerror = () => reject(new Error('Upload failed — check your connection.'));
      xhr.send(blob);
    });
  }

  function folderFor(kind) {
    switch (kind) {
      case 'logo': return 'logos';
      case 'cover': return 'menus';
      case 'menu_item': return 'items';
      case 'promotion': return 'promotions';
      case 'avatar': return 'avatars';
      default: return 'items';
    }
  }

  // opts: { shopId, kind: 'logo'|'cover'|'menu_item'|'promotion'|'avatar', itemId?, onProgress? }
  // Avatars are owned by the uploading user, not a shop — stored under
  // avatars/{userId}/ instead of {kind}/{shopId}/, and skip the shop-scoped
  // `images` metadata table entirely (its RLS is shop-scoped and would
  // reject a row with no matching shop either way; a customer's avatar_url
  // on their own profile is all the bookkeeping this needs).
  async function uploadImage(file, opts) {
    opts = opts || {};
    if (!file) return { error: 'No file selected.' };
    if (!ALLOWED_TYPES.includes(file.type)) return { error: 'Please choose a JPG, PNG or WEBP image.' };
    if (file.size > MAX_UPLOAD_BYTES) return { error: 'Image must be smaller than 10MB.' };
    if (!App.Store.state.profile) return { error: 'Please sign in to upload images.' };
    const isAvatar = opts.kind === 'avatar';
    if (!isAvatar && !opts.shopId) return { error: 'No shop selected for this upload.' };

    let optimized;
    try {
      optimized = await optimizeImage(file);
    } catch (e) {
      return { error: 'This image could not be processed. Please try a different file.' };
    }

    const ext = extFor(optimized.format);
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const ownerId = isAvatar ? App.Store.state.profile.id : opts.shopId;
    const path = `${folderFor(opts.kind)}/${ownerId}/${filename}`;

    try {
      await uploadWithProgress(path, optimized.blob, `image/${optimized.format}`, opts.onProgress);
    } catch (e) {
      return { error: e.message || 'Upload failed. Please try again.' };
    }

    const { data: pub } = App.sb.storage.from(BUCKET).getPublicUrl(path);
    const url = pub.publicUrl;

    if (!isAvatar) {
      const { error: metaErr } = await App.sb.from('images').insert({
        shop_id: opts.shopId,
        item_id: opts.itemId || null,
        kind: opts.kind || 'menu_item',
        storage_path: path,
        url,
        original_filename: file.name,
        optimized_filename: filename,
        original_size: optimized.originalSize,
        optimized_size: optimized.optimizedSize,
        image_format: optimized.format,
        uploaded_by: App.Store.state.profile.id,
      });
      if (metaErr) console.error('Image metadata not recorded:', metaErr);
    }

    return {
      data: {
        url, path,
        originalSize: optimized.originalSize, optimizedSize: optimized.optimizedSize,
        width: optimized.width, height: optimized.height,
      },
    };
  }

  // Removes a previously-uploaded file (used when a manager replaces an
  // image) — best-effort; a failure here never blocks the new image from
  // being used, it just leaves an orphaned file for later cleanup.
  async function deleteImage(path) {
    if (!path) return;
    try {
      await App.sb.storage.from(BUCKET).remove([path]);
      await App.sb.from('images').delete().eq('storage_path', path);
    } catch (e) {
      console.error('Failed to clean up old image:', e);
    }
  }

  // Looks up a previously-uploaded file by its public URL and removes it —
  // used after a form save succeeds, to clean up the image it just replaced.
  async function deleteImageByUrl(url) {
    if (!url) return;
    const { data } = await App.sb.from('images').select('storage_path').eq('url', url).maybeSingle();
    if (data && data.storage_path) await deleteImage(data.storage_path);
  }

  return { uploadImage, deleteImage, deleteImageByUrl, optimizeImage, MAX_UPLOAD_BYTES };
})();
