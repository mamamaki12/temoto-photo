// .exe のアイコン・名前（エクスプローラーのプロパティに出るもの）を書き換える（Windows の機械なしでできる）
// 使い方: node set-exe-info.cjs TemotoPhoto.exe icon.png 0.1.0
const fs = require('node:fs');
const ResEdit = require('resedit');
const [exe, png, version] = process.argv.slice(2);

// PNG をそのまま 1 枚入れた .ico（Windows Vista 以降はこれで表示できる）
const img = fs.readFileSync(png);
const ico = Buffer.alloc(22); ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
ico[6] = 0; ico[7] = 0; ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(img.length, 14); ico.writeUInt32LE(22, 18);
const iconFile = ResEdit.Data.IconFile.from(Buffer.concat([ico, img]));

const pe = ResEdit.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(pe);
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const id = groups.length ? groups[0].id : 1; const lang = groups.length ? groups[0].lang : 1033;
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, lang, iconFile.icons.map((i) => i.data));
const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
const v = version.split('.').map(Number);
vi.setFileVersion(v[0], v[1], v[2], 0, 1033); vi.setProductVersion(v[0], v[1], v[2], 0, 1033);
vi.setStringValues({ lang: 1033, codepage: 1200 }, {
  FileDescription: 'Temoto Photo', ProductName: 'Temoto Photo', CompanyName: 'mamamaki12', OriginalFilename: 'TemotoPhoto.exe',
  InternalName: 'TemotoPhoto', LegalCopyright: '',
});
vi.outputToResourceEntries(res.entries);
res.outputResource(pe);
fs.writeFileSync(exe, Buffer.from(pe.generate()));
console.log('exe info set');
