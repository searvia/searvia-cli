# searvia

**iOS ve Android uygulamalarını terminalden yayımlayın.** **App Store Connect** ve **Google Play** için mağaza
metinleri, ekran görüntüleri, derlemeler, incelemeye gönderme ve kademeli yayın; üstüne **çevrimdışı ASO denetimi** —
App Store Connect'i ya da Play Console'u açmadan, baştan sona.

```bash
npx searvia audit            # hemen çalışır, anahtar gerekmez
```

- **Çalışma zamanı bağımlılığı yok.** Yalnız Node ≥ 20'nin kendi modülleri (fetch, crypto, zlib). MIT lisanslı.
- **fastlane uyumlu klasörler.** Mevcut `fastlane/metadata` ve `fastlane/screenshots` klasörlerinizle çalışır.
- **Varsayılan olarak güvenli.** Her yazma işlemi `--yes` eklenene kadar alan alan fark gösteren bir denemedir.
- **CI için tasarlandı.** Her komutta `--json`, anlamlı çıkış kodları, ortam değişkeninden kimlik bilgisi; derleme
  yüklemek için Xcode gerekmez (App Store Connect build upload API) — `ubuntu-latest` üzerinde çalışır.
- **Anahtarlarınız makinenizde kalır.** Yalnız Apple'a, Google'a ve (isteğe bağlı Searvia komutları için) Searvia'ya
  gönderilir.

[English README](./README.md)

## Hızlı başlangıç

```bash
npm install -g searvia        # ya da npx searvia <komut>
cd uygulamam
searvia init                  # fastlane klasörlerini, Appfile'ı, applicationId'yi bulur; searvia.config.json yazar
searvia doctor                # anahtarların çalıştığını denetler (salt okunur)
searvia pull                  # tüm dilleri fastlane/metadata altına indirir
searvia audit                 # dil başına ASO puanı ve somut düzeltmeler
searvia push                  # farkı gösterir …
searvia push --yes            # … ve uygular
searvia release --platform ios --ipa build/App.ipa --yes
searvia release --platform android --aab app-release.aab --rollout 10 --yes
```

## Kimlik bilgileri

| Mağaza | Gerekenler | Nereye |
|---|---|---|
| App Store Connect | API anahtarı (Users and Access › Integrations › App Store Connect API), **App Manager** rolü. Ekip anahtarında issuer id vardır, bireysel anahtarda yoktur. | `.searvia/config.json` ya da `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY` / `ASC_PRIVATE_KEY_PATH` |
| Google Play | Service account JSON anahtarı; Play Console › Users and permissions'ta yayın ve mağaza girişi izinleriyle davet edilmiş. | `.searvia/config.json` ya da `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` / `GOOGLE_PLAY_SERVICE_ACCOUNT_PATH` |
| Searvia (isteğe bağlı) | [searvia.com/settings/api](https://searvia.com/settings/api) adresinden API anahtarı ([searvia.com](https://searvia.com)'da ücretsiz hesap) | `searvia login` ya da `SEARVIA_API_KEY` |

`searvia.config.json` (depoya girer) ve `.searvia/config.json` (`init` tarafından git dışında tutulur) birleştirilir;
ortam değişkenleri her ikisini de ezer.

## Komutlar

| Komut | Ne yapar |
|---|---|
| `init` | Yapılandırmayı yazar, fastlane klasörlerini ve anahtar dosyalarını bulur, `.searvia/`'yı `.gitignore`'a ekler. |
| `doctor` | Yapılandırmayı, klasörleri ve anahtarları salt okunur denetler. |
| `pull` | Tüm dillerin tüm metinlerini (ad, alt başlık, anahtar kelimeler, açıklama, tanıtım metni, yenilikler, adresler; Play başlık, kısa/uzun açıklama, sürüm notları) indirir. |
| `push` | Alan alan fark; `--yes` ile yazar. Eksik dil için `--create-locales`, düzenlenebilir sürüm yoksa `--create-version x.y.z`. |
| `audit` | Çevrimdışı ASO denetimi (0–100). `--fix` anahtar kelime alanını 100 bayta yeniden paketler; `--min-score` CI'da çıkış kodu 3 verir. |
| `screenshots upload\|download\|clear` | App Store ekran görüntüsü setleri (boyut doğrulama, rezervasyon → parça yükleme → MD5 onayı) ve Play görselleri. |
| `build upload` | iOS: App Store Connect build upload API (Xcode gerekmez) ya da `--altool`. Android: kesintiye dayanıklı AAB yükleme ve kanal. |
| `release` | Uçtan uca yayın: sürüm → metin → görseller → derleme → ihracat uyumu → inceleme bilgisi → yaş derecesi → yayın türü → kademeli yayın → incelemeye gönderme; Play'de tek düzenlemede liste → görsel → paket → kanal (% yayın) → onay. |
| `status` | İnceleme durumu (App Store) ve kanal durumu (Play). |
| `submit [--cancel]` | Düzenlenebilir sürümü incelemeye gönderir ya da bekleyen gönderimi geri çeker. |
| `workflow run <dosya>` | YAML/JSON adım listesi çalıştırır (CI için). |
| `login`, `keywords`, `research`, `popularity`, `suggest`, `projects`, `mcp` | Searvia hesabınızdan sıra takibi, popülerlik, zorluk ve yapay zekâ meta veri önerileri (MCP üzerinden). |

## ASO denetimi

- **App Store:** anahtar kelime alanı **UTF-8 bayt** ile ölçülür (100; Türkçe ç/ş/ğ/ı/ö/ü 2, Çince/Japonca/Korece 3
  bayt), başlık ve alt başlık 30 karakter, **160 karakterlik dizin havuzu**, alanlar arası ve alan içi tekrar, dile göre
  dolgu kelimeleri (İspanyolca *para* dolgu, Türkçe *para* değil), tekil/çoğul ikizleri, başka markalar, kategori
  kelimeleri, virgül biçimi ve **aynı ülkede dizine giren diller arası çakışma** (Türkiye hem `tr` hem `en-GB`'yi
  dizine alır).
- **Google Play:** alan sınırları, %3'ü aşan yoğunluk, kısa açıklamada tekrar, başlıkta tekrar, ilk 300 karakterde
  geçmeyen hedef kelimeler.

## API ile yapılamayanlar

| Mağaza | Konu |
|---|---|
| App Store | **App Privacy** (gizlilik etiketleri) — API yok: `https://appstoreconnect.apple.com/apps/<appId>/distribution/privacy` |
| App Store | Uygulama kaydını oluşturmak (`POST /v1/apps` yok), sözleşmeler, vergi ve banka |
| Google Play | Uygulamayı oluşturmak; Veri güvenliği, içerik derecelendirme anketi, hedef kitle, reklam, uygulama erişimi beyanları — API yok (Play Console › Politika ve programlar › Uygulama içeriği) |

## Güvenlik

Anahtarlar yalnız Apple, Google ve (Searvia komutlarında) Searvia sunucularına gönderilir; telemetri yoktur. Demo
hesap parolası ortak yapılandırmadan değil ortam değişkeninden okunur. `--yes` olmadan mağazada hiçbir şey değişmez.

## Lisans

MIT © Searvia contributors
