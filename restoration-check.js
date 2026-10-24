import { restorePhoto } from './restoration-photo.js';
import { COLOR_SPACE } from './color.js';
import { download } from './lib.js';

const $ = (id) => document.getElementById(id);
const before = $('before'); const after = $('after');
const ctx = (c) => c.getContext('2d', { colorSpace: COLOR_SPACE, willReadFrequently: true });
let source = null; let controller = null; let version = 0; let filename = 'photo';
const status = (s) => { $('status').textContent = s; };
function busy(on) {
  $('run').disabled = on || !source; $('cancel').disabled = !on;
  for (const id of ['photo', 'amount', 'noise']) $(id).disabled = on;
}
for (const id of ['amount', 'noise']) $(id).addEventListener('input', () => {
  $(`${id}-value`).value = $(id).value;
  $('save').disabled = true;
  if (source) status('設定を変更しました。「補正して比較」で更新してください。');
});
$('actual').addEventListener('change', () => $('comparison').classList.toggle('actual', $('actual').checked));
// 原寸で同じ場所を比較できるよう、スクロールを同期。
const views = [...document.querySelectorAll('.viewport')];
for (const view of views) view.addEventListener('scroll', () => {
  for (const other of views) if (other !== view && (other.scrollLeft !== view.scrollLeft || other.scrollTop !== view.scrollTop)) {
    other.scrollLeft = view.scrollLeft; other.scrollTop = view.scrollTop;
  }
});
$('photo').addEventListener('change', async () => {
  const ticket = ++version; source = null; $('save').disabled = true; busy(false);
  before.width = after.width = 1; before.height = after.height = 1; $('progress').value = 0;
  const file = $('photo').files[0]; if (!file) return;
  status('写真を読み込んでいます…'); let bmp;
  try {
    bmp = await createImageBitmap(file);
    if (ticket !== version) return;
    if (bmp.width * bmp.height > 4_000_000) throw new Error('400万画素を超えています。原寸を保つため自動縮小せず停止しました。');
    before.width = after.width = bmp.width; before.height = after.height = bmp.height;
    ctx(before).drawImage(bmp, 0, 0); source = ctx(before).getImageData(0, 0, bmp.width, bmp.height, { colorSpace: COLOR_SPACE });
    filename = file.name.replace(/\.[^.]+$/, ''); status(`${bmp.width}×${bmp.height}・元画像を変更せず比較します。`);
  } catch (e) { if (ticket === version) status(e.message || '写真を読み込めませんでした'); }
  finally { bmp?.close(); if (ticket === version) busy(false); }
});
$('run').addEventListener('click', async () => {
  if (!source || controller) return;
  controller = new AbortController(); busy(true); $('save').disabled = true;
  $('progress').value = 0; status('補正しています… 残り100%');
  try {
    const result = await restorePhoto(source, { amount: Number($('amount').value), noise: Number($('noise').value) }, {
      signal: controller.signal, onProgress: ({ percent }) => {
        $('progress').value = Math.min(percent, 99); status(`補正しています… 残り${100 - Math.min(percent, 99)}%`);
      },
    });
    ctx(after).putImageData(new ImageData(result.data, result.width, result.height, { colorSpace: result.colorSpace }), 0, 0);
    $('progress').value = 100; $('save').disabled = false;
    status('補正完了（残り0%）。肌・髪・レースを原寸で比較してください。');
  } catch (e) { status(e.name === 'AbortError' ? '中止しました。元画像は変更していません。' : `補正できませんでした: ${e.message}`); }
  finally { controller = null; busy(false); }
});
$('cancel').addEventListener('click', () => controller?.abort());
addEventListener('pagehide', () => { version++; controller?.abort(); });
$('save').addEventListener('click', async () => {
  $('save').disabled = true;
  try {
    const blob = await new Promise((resolve) => after.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNGを作成できませんでした');
    download(blob, `${filename}_restored.png`);
  } catch (e) { status(e.message); }
  finally { $('save').disabled = false; }
});
