# Universal Media Downloader — build awal 0.1.0

Implementasi awal dari PRD v1.4, bukan rilis final yang sudah memenuhi seluruh acceptance criteria. UI dark ringkas, Bahasa Indonesia, popup dan side panel berbagi implementasi. Tidak ada akun, server pemrosesan, aplikasi pendamping, atau kode library yang diambil dari CDN saat runtime.

## Pasang — tanpa build / npm
1. Ekstrak ZIP ini.
2. Buka `chrome://extensions` di Chrome 120+.
3. Nyalakan **Developer mode**.
4. Pilih **Load unpacked**, lalu pilih folder `media-downloader` yang berisi `manifest.json`.
5. Muat ulang halaman sumber agar content script/hook mulai bekerja. Putar media, lalu buka ekstensi.

`npm` hanya diperlukan bila ingin menjalankan tes pengembangan, bukan untuk memakai ekstensi.

## Isi build
- Manifest V3, background service worker, sensor network/DOM/MAIN-world, offscreen worker.
- Daftar media tab aktif, cache URL+metadata dalam `storage.session`, tanpa fetch segmen media saat deteksi.
- Popup dan side panel: pencarian, filter tipe dan filter lanjutan, dropdown kualitas, alasan tidak siap, nama file, antrean, riwayat, pengaturan.
- Pratinjau video hanya saat hover/fokus setelah 350 ms. Tanpa tombol play. HLS.js dan dash.js dibundel lokal. Reduced-motion menonaktifkan autoplay hover.
- Parser HLS master/media, rendition audio, ENDLIST, byterange, AES-128; penolakan SAMPLE-AES/DRM dan live sebagai unduhan utuh.
- Parser DASH SegmentList / SegmentTemplate + timeline dasar; pairing audio-video, mux lewat MediaBunny.
- Download eksplisit ke offscreen, staging memori/OPFS, retry, perakitan, pemeriksaan durasi/header sebelum diserahkan ke downloads API.
- Gambar satu per satu dan ZIP store-only; subtitle sidecar dasar.
- Mode tab recording melalui tabCapture + MediaRecorder, dilabeli tangkapan parsial hasil re-encode.

## Batas yang belum memenuhi PRD final
Ini penting: jangan menganggap versi 0.1.0 siap produksi atau universal.

| Bagian | Status / batas |
|---|---|
| ffmpeg.wasm | Belum dibundel dan belum diimplementasikan. Tidak ada fallback transcode FFmpeg. |
| DASH | SegmentBase/sidx & WebM Cues belum tersedia sebagai jalur READY. Repeat timeline negatif, beberapa bentuk pewarisan, multi-Period dan konten kompleks belum lengkap. |
| HLS | Playlist langsung tanpa informasi codec/bandwidth master ditolak konservatif. Discontinuity ditolak. Ekstraksi audio-only dari semua varian HLS belum diekspos. |
| YouTube | Hanya URL format yang tersedia langsung dari metadata player. Cipher/signature belum diselesaikan. Belum diuji end-to-end terhadap YouTube; tidak ada klaim semua video bisa disimpan. |
| Job besar | Staging OPFS ada, tetapi tahap mux masih memakai BufferTarget di memori. Bukan pipeline O(1) end-to-end. Ambang default belum dibenchmark pada perangkat pengguna. |
| Antrean & resume | Pause/resume selama job hidup bersifat dasar. Pembatasan jumlah job konkuren, reorder, retry job gagal, resume lintas mati worker/offscreen belum lengkap. |
| Lifecycle worker | Penyelesaian download dan rekonstruksi job lintas suspend/restart masih perlu pengujian penuh. Jangan mengandalkan resume tahan restart. |
| Auth | Menggunakan cookie browser melalui credentials include; pembatasan cookie/partition/situs dapat menyebabkan gagal. Jalur DNR/cookies khusus per situs belum selesai dan tidak diaktifkan. |
| Gambar | Dedup srcset/lazy belum mencakup semua pola; URL data dan beberapa format perlu pengujian tambahan. Konversi gambar eksplisit belum tersedia. |
| Subtitle | Sidecar dasar; embedding, SRT conversion dan beberapa playlist subtitle belum lengkap. |
| Pemeriksaan integritas | Parser output dan durasi diperiksa, tetapi belum seluruh invariant byte/container/track dari PRD. Jangan menganggap READY bukti semua byte sudah diperiksa. |
| UI | Kategori/filter utama ada. Grid gambar, pengurutan, progres & recording masih memerlukan uji interaksi di Chrome sebenarnya. |

File yang gagal diproses tidak sengaja ditawarkan untuk disimpan parsial. READY adalah kelayakan manifest/metadatanya, bukan jaminan hasil jaringan di kemudian hari.

## Pengujian yang sudah dilakukan
- Pemeriksaan sintaks seluruh file JavaScript non-vendor.
- `npm test`: 10 tes unit lulus (parser HLS/audio rendition, DRM/live gate, timeline DASH repeat, byterange, label resolusi, sanitasi filename, CRC/ZIP, IV AES, atribut quoted).
- Eksperimen engine MediaBunny di Node terhadap contoh HLS Apple dan DASH Big Buck Bunny: TS→MP4, mux trek audio/video, ekstraksi AAC berhasil diparse kembali.
- Uji ekstensi Chrome end-to-end belum berhasil dijalankan di lingkungan ini: browser sandbox tidak memiliki shared library sistem yang diperlukan. Tes Node tidak menggantikan uji Chrome, auth situs, atau acceptance tests PRD.

## Pratinjau desain
`ui/popup.html?preview=1` menggunakan data contoh yang diberi label **Pratinjau tampilan**. Data itu bukan hasil deteksi situs dan tombolnya tidak membuat job nyata. Mode ekstensi normal tidak memakai data contoh.

## Privasi & izin
Izin host `<all_urls>` diperlukan untuk observasi media lintas situs, tetapi event deteksi dibatasi tab aktif. URL bertoken tidak sengaja ditulis ke history; history hanya nama berkas, host dan metadata. Tidak ada analitik eksternal. Konten ber-DRM ditolak; tidak ada ekstraksi CDM atau pemutaran lisensi. Gunakan hanya media yang kamu berhak simpan.

## Library lokal
- MediaBunny 1.62.1 — MPL-2.0, source: https://github.com/Vanilagy/mediabunny (tidak dimodifikasi).
- HLS.js 1.5.20 — Apache-2.0, source: https://github.com/video-dev/hls.js.
- dash.js 4.7.4 — BSD-3-Clause, source: https://github.com/Dash-Industry-Forum/dash.js.

Teks lisensi ada di `lib/licenses/`. Tidak ada instalasi library tambahan saat pemakaian.
