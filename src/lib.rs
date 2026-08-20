//! # rwss
//!
//! Browser-friendly WASM facade for rendering ASS/SSA subtitles with rassa.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};

use rassa::{
    FontProvider, FontconfigProvider, ImagePlane, ParsedEvent, ParsedStyle, Renderer, Script,
};
use rassa_fonts::{
    FontMatch, FontProviderCacheKey, FontProviderKind, FontQuery, font_face_glyph_index,
};
use rassa_shape::{register_virtual_font_bytes, virtual_font_bytes};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[cfg(feature = "console_error_panic_hook")]
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

#[derive(Clone, Debug)]
struct VirtualFontRecord {
    family: String,
    aliases: Vec<String>,
    path: PathBuf,
    face_index: Option<u32>,
    style: Option<String>,
    style_key: Option<String>,
    is_fallback: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterFontOptions {
    name: Option<String>,
    aliases: Option<Vec<String>>,
    style: Option<String>,
    is_fallback: Option<bool>,
}

#[derive(Clone, Debug)]
struct FontRegistrySnapshot {
    virtual_fonts: Vec<VirtualFontRecord>,
    fallback_families: Vec<String>,
    layout_cache_key: FontProviderCacheKey,
}

impl Default for FontRegistrySnapshot {
    fn default() -> Self {
        Self {
            virtual_fonts: Vec::new(),
            fallback_families: Vec::new(),
            layout_cache_key: FontProviderCacheKey::new(),
        }
    }
}

type FontCharacterCache = HashMap<(PathBuf, u32, char), bool>;

static FONT_REGISTRY: OnceLock<Mutex<Arc<FontRegistrySnapshot>>> = OnceLock::new();
static FONT_CHARACTER_CACHE: OnceLock<Mutex<FontCharacterCache>> = OnceLock::new();
static SYSTEM_FONT_PROVIDER: OnceLock<FontconfigProvider> = OnceLock::new();

const MAX_FONT_BYTES: usize = 32 * 1024 * 1024;

fn font_registry() -> &'static Mutex<Arc<FontRegistrySnapshot>> {
    FONT_REGISTRY.get_or_init(|| Mutex::new(Arc::new(FontRegistrySnapshot::default())))
}

fn font_character_cache() -> &'static Mutex<FontCharacterCache> {
    FONT_CHARACTER_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn system_font_provider() -> &'static FontconfigProvider {
    SYSTEM_FONT_PROVIDER.get_or_init(FontconfigProvider::new)
}

struct RwssFontProvider {
    snapshot: Arc<FontRegistrySnapshot>,
}

impl RwssFontProvider {
    fn new() -> Self {
        Self {
            snapshot: font_registry()
                .lock()
                .expect("virtual font registry mutex poisoned")
                .clone(),
        }
    }
}

impl FontProvider for RwssFontProvider {
    fn resolve(&self, query: &FontQuery) -> FontMatch {
        let family_key = normalize_font_key(&query.family);
        let style_key = query.style.as_deref().map(normalize_font_key);
        if let Some(font) =
            self.preferred_matching_font(&family_key, style_key.as_deref(), |_| true)
        {
            return font_match_from_record(font, query);
        }

        if let Some(font) = self.resolve_configured_fallback(query) {
            return font;
        }

        if let Some(font) = self
            .snapshot
            .virtual_fonts
            .iter()
            .rev()
            .find(|font| !font.is_fallback)
            .or_else(|| {
                self.snapshot
                    .virtual_fonts
                    .iter()
                    .rev()
                    .find(|font| font.is_fallback)
            })
        {
            return font_match_from_record(font, query);
        }

        system_font_provider().resolve(query)
    }

    fn resolve_for_text(&self, query: &FontQuery, text: &str) -> FontMatch {
        let family_key = normalize_font_key(&query.family);
        let style_key = query.style.as_deref().map(normalize_font_key);

        if let Some(font) =
            self.preferred_matching_font(&family_key, style_key.as_deref(), |font| {
                font_record_supports_text(font, text)
            })
        {
            return font_match_from_record(font, query);
        }

        if let Some(font) = self.resolve_configured_fallback_for_text(text) {
            return font_match_from_record(font, query);
        }

        if let Some(font) = self
            .snapshot
            .virtual_fonts
            .iter()
            .rev()
            .filter(|font| !font.is_fallback)
            .find(|font| font_record_supports_text(font, text))
            .or_else(|| {
                self.snapshot
                    .virtual_fonts
                    .iter()
                    .rev()
                    .filter(|font| font.is_fallback)
                    .find(|font| font_record_supports_text(font, text))
            })
        {
            return font_match_from_record(font, query);
        }

        system_font_provider().resolve_for_text(query, text)
    }

    fn layout_cache_key(&self) -> Option<FontProviderCacheKey> {
        Some(self.snapshot.layout_cache_key.clone())
    }
}

impl RwssFontProvider {
    fn preferred_matching_font<'a>(
        &'a self,
        family_key: &str,
        style_key: Option<&str>,
        predicate: impl Fn(&VirtualFontRecord) -> bool,
    ) -> Option<&'a VirtualFontRecord> {
        for is_fallback in [false, true] {
            let matching = || {
                self.snapshot.virtual_fonts.iter().rev().filter(|font| {
                    font.is_fallback == is_fallback
                        && font.aliases.iter().any(|alias| alias == family_key)
                        && predicate(font)
                })
            };
            if let Some(style_key) = style_key
                && let Some(font) =
                    matching().find(|font| font.style_key.as_deref() == Some(style_key))
            {
                return Some(font);
            }
            if let Some(font) = matching().next() {
                return Some(font);
            }
        }
        None
    }

    fn resolve_configured_fallback(&self, query: &FontQuery) -> Option<FontMatch> {
        let style_key = query.style.as_deref().map(normalize_font_key);
        for family_key in &self.snapshot.fallback_families {
            if let Some(font) =
                self.preferred_matching_font(family_key, style_key.as_deref(), |_| true)
            {
                return Some(font_match_from_record(font, query));
            }
        }
        None
    }

    fn resolve_configured_fallback_for_text(&self, text: &str) -> Option<&VirtualFontRecord> {
        for family_key in &self.snapshot.fallback_families {
            if let Some(font) = self.preferred_matching_font(family_key, None, |font| {
                font_record_supports_text(font, text)
            }) {
                return Some(font);
            }
        }
        None
    }
}

fn font_match_from_record(font: &VirtualFontRecord, query: &FontQuery) -> FontMatch {
    let (synthetic_bold, synthetic_italic) =
        synthetic_style_flags(query.style.as_deref(), font.style.as_deref());
    FontMatch {
        family: font.family.clone(),
        path: Some(font.path.clone()),
        face_index: font.face_index,
        style: font.style.clone().or_else(|| query.style.clone()),
        synthetic_bold,
        synthetic_italic,
        provider: FontProviderKind::Attached,
    }
}

fn font_record_supports_text(font: &VirtualFontRecord, text: &str) -> bool {
    let mut required = text
        .chars()
        .filter(|character| !character.is_whitespace() && !character.is_control())
        .collect::<Vec<_>>();
    required.sort_unstable();
    required.dedup();
    if required.is_empty() {
        return true;
    }

    let face_index = font.face_index.unwrap_or(0);
    let mut missing = Vec::new();
    {
        let cache = font_character_cache()
            .lock()
            .expect("virtual font character cache mutex poisoned");
        for character in required {
            match cache.get(&(font.path.clone(), face_index, character)) {
                Some(true) => {}
                Some(false) => return false,
                None => missing.push(character),
            }
        }
    }
    if missing.is_empty() {
        return true;
    }

    let Some(bytes) = virtual_font_bytes(&font.path) else {
        return false;
    };
    let Ok(face) = ttf_parser::Face::parse(bytes.as_slice(), face_index) else {
        return false;
    };
    let results = missing
        .into_iter()
        .map(|character| {
            let supported =
                font_face_glyph_index(&face, character).is_some_and(|glyph| glyph.0 != 0);
            (character, supported)
        })
        .collect::<Vec<_>>();
    let supported = results.iter().all(|(_, supported)| *supported);
    let mut cache = font_character_cache()
        .lock()
        .expect("virtual font character cache mutex poisoned");
    for (character, supported) in results {
        cache.insert((font.path.clone(), face_index, character), supported);
    }
    supported
}

#[wasm_bindgen(js_name = registerFont)]
pub fn register_font(
    name: &str,
    bytes: Vec<u8>,
    options: Option<JsValue>,
) -> Result<String, JsValue> {
    if name.trim().is_empty() {
        return Err(JsValue::from_str("Font name must not be empty"));
    }
    register_font_inner(Some(name), bytes, options)
}

#[wasm_bindgen(js_name = registerFontData)]
pub fn register_font_data(bytes: Vec<u8>, options: Option<JsValue>) -> Result<String, JsValue> {
    register_font_inner(None, bytes, options)
}

#[wasm_bindgen(js_name = setFallbackFonts)]
pub fn set_fallback_fonts(fonts: JsValue) -> Result<(), JsValue> {
    let fonts = serde_wasm_bindgen::from_value::<Vec<String>>(fonts).map_err(js_error)?;
    let mut normalized = Vec::new();
    for font in fonts {
        let key = normalize_font_key(font.trim_start_matches('@'));
        if !key.is_empty() && !normalized.contains(&key) {
            normalized.push(key);
        }
    }
    let mut registry = font_registry()
        .lock()
        .expect("fallback font registry mutex poisoned");
    let snapshot = Arc::make_mut(&mut registry);
    snapshot.fallback_families = normalized;
    snapshot.layout_cache_key = FontProviderCacheKey::new();
    Ok(())
}

fn register_font_inner(
    name_hint: Option<&str>,
    bytes: Vec<u8>,
    options: Option<JsValue>,
) -> Result<String, JsValue> {
    let bytes = normalize_font_bytes(bytes).map_err(|error| JsValue::from_str(&error))?;
    let options = options
        .map(serde_wasm_bindgen::from_value::<RegisterFontOptions>)
        .transpose()
        .map_err(js_error)?;
    let metadata = font_metadata_from_bytes(&bytes);
    if metadata.is_empty() {
        return Err(JsValue::from_str(
            "Font data is not a supported OpenType/TrueType font",
        ));
    }
    let configured_family = options
        .as_ref()
        .and_then(|options| options.name.as_deref())
        .or(name_hint)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned);
    let path_family = configured_family
        .as_ref()
        .cloned()
        .or_else(|| metadata.iter().find_map(|metadata| metadata.family.clone()))
        .unwrap_or_else(|| "font".to_owned());
    let configured_style = options.as_ref().and_then(|options| options.style.clone());
    let is_fallback = options
        .as_ref()
        .and_then(|options| options.is_fallback)
        .unwrap_or(false);
    let mut configured_aliases = Vec::new();
    if let Some(family) = &configured_family {
        configured_aliases.push(normalize_font_key(family));
    }
    if let Some(name_hint) = name_hint {
        configured_aliases.push(normalize_font_key(name_hint));
    }
    configured_aliases.extend(
        options
            .as_ref()
            .and_then(|options| options.aliases.as_ref())
            .into_iter()
            .flatten()
            .map(|alias| normalize_font_key(alias.trim_start_matches('@'))),
    );
    configured_aliases.retain(|alias| !alias.is_empty());
    configured_aliases.sort();
    configured_aliases.dedup();
    let path = PathBuf::from(format!(
        "/rwss-fontconfig/{:016x}-{}",
        stable_font_hash(&path_family, &bytes),
        sanitize_font_name(&path_family)
    ));
    register_virtual_font_bytes(path.clone(), bytes);
    let records = metadata
        .into_iter()
        .map(|metadata| {
            let family = configured_family
                .clone()
                .or(metadata.family)
                .unwrap_or_else(|| "font".to_owned());
            let style = configured_style.clone().or(metadata.style);
            let mut aliases = configured_aliases.clone();
            aliases.push(normalize_font_key(&family));
            aliases.extend(metadata.aliases);
            aliases.retain(|alias| !alias.is_empty());
            aliases.sort();
            aliases.dedup();
            VirtualFontRecord {
                family,
                aliases,
                path: path.clone(),
                face_index: (metadata.face_index > 0).then_some(metadata.face_index),
                style_key: style.as_deref().map(normalize_font_key),
                style,
                is_fallback,
            }
        })
        .collect::<Vec<_>>();
    let mut registry = font_registry()
        .lock()
        .expect("virtual font registry mutex poisoned");
    let snapshot = Arc::make_mut(&mut registry);
    snapshot.virtual_fonts.retain(|font| font.path != path);
    snapshot.virtual_fonts.extend(records);
    snapshot.layout_cache_key = FontProviderCacheKey::new();
    Ok(path.to_string_lossy().into_owned())
}

#[wasm_bindgen(js_name = clearRegisteredFonts)]
pub fn clear_registered_fonts() {
    let mut registry = font_registry()
        .lock()
        .expect("virtual font registry mutex poisoned");
    *Arc::make_mut(&mut registry) = FontRegistrySnapshot::default();
    font_character_cache()
        .lock()
        .expect("virtual font character cache mutex poisoned")
        .clear();
}

#[wasm_bindgen(js_name = listRegisteredFonts)]
pub fn list_registered_fonts() -> Result<JsValue, JsValue> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct RegisteredFontData {
        family: String,
        aliases: Vec<String>,
        path: String,
        style: Option<String>,
        is_fallback: bool,
    }

    let snapshot = font_registry()
        .lock()
        .expect("virtual font registry mutex poisoned")
        .clone();
    let fonts = snapshot
        .virtual_fonts
        .iter()
        .map(|font| RegisteredFontData {
            family: font.family.clone(),
            aliases: font.aliases.clone(),
            path: font.path.to_string_lossy().into_owned(),
            style: font.style.clone(),
            is_fallback: font.is_fallback,
        })
        .collect::<Vec<_>>();
    to_js(&fonts)
}

#[wasm_bindgen(js_name = resolveFont)]
pub fn resolve_font(name: &str) -> Result<JsValue, JsValue> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FontMatchData {
        family: String,
        path: Option<String>,
        style: Option<String>,
        synthetic_bold: bool,
        synthetic_italic: bool,
        provider: String,
    }

    let provider = RwssFontProvider::new();
    let resolved = provider.resolve(&FontQuery::new(name));
    let data = FontMatchData {
        family: resolved.family,
        path: resolved
            .path
            .map(|path| path.to_string_lossy().into_owned()),
        style: resolved.style,
        synthetic_bold: resolved.synthetic_bold,
        synthetic_italic: resolved.synthetic_italic,
        provider: format!("{:?}", resolved.provider),
    };
    to_js(&data)
}

fn normalize_font_key(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn sanitize_font_name(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "font".to_owned()
    } else {
        sanitized
    }
}

fn stable_font_hash(name: &str, bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in name.as_bytes().iter().chain(bytes.iter()) {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn synthetic_style_flags(requested: Option<&str>, resolved: Option<&str>) -> (bool, bool) {
    let requested = requested.map(normalize_font_key).unwrap_or_default();
    let resolved = resolved.map(normalize_font_key).unwrap_or_default();
    (
        requested.contains("bold") && !resolved.contains("bold"),
        (requested.contains("italic") || requested.contains("oblique"))
            && !(resolved.contains("italic") || resolved.contains("oblique")),
    )
}

fn normalize_font_bytes(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    if bytes.is_empty() {
        return Err("Font bytes must not be empty".to_owned());
    }
    if bytes.len() > MAX_FONT_BYTES {
        return Err(format!(
            "Font data exceeds the {} MiB limit",
            MAX_FONT_BYTES / (1024 * 1024)
        ));
    }

    let decoded = match bytes.get(..4) {
        Some(b"wOFF") => {
            validate_declared_font_size(&bytes)?;
            wuff::decompress_woff1(&bytes)
                .map_err(|error| format!("Failed to decode WOFF font: {error}"))?
        }
        Some(b"wOF2") => {
            validate_declared_font_size(&bytes)?;
            wuff::decompress_woff2(&bytes)
                .map_err(|error| format!("Failed to decode WOFF2 font: {error}"))?
        }
        _ => bytes,
    };
    if decoded.len() > MAX_FONT_BYTES {
        return Err(format!(
            "Decoded font exceeds the {} MiB limit",
            MAX_FONT_BYTES / (1024 * 1024)
        ));
    }
    Ok(decoded)
}

fn validate_declared_font_size(bytes: &[u8]) -> Result<(), String> {
    let declared = bytes
        .get(16..20)
        .and_then(|value| <[u8; 4]>::try_from(value).ok())
        .map(u32::from_be_bytes)
        .ok_or_else(|| "Compressed font header is truncated".to_owned())?;
    if declared == 0 || declared as usize > MAX_FONT_BYTES {
        return Err(format!(
            "Decoded font exceeds the {} MiB limit",
            MAX_FONT_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

struct FontMetadata {
    face_index: u32,
    family: Option<String>,
    style: Option<String>,
    aliases: Vec<String>,
}

fn font_metadata_from_bytes(bytes: &[u8]) -> Vec<FontMetadata> {
    let face_count = ttf_parser::fonts_in_collection(bytes).unwrap_or(1).max(1);
    (0..face_count)
        .filter_map(|face_index| {
            let face = ttf_parser::Face::parse(bytes, face_index).ok()?;
            let family = font_name(&face, ttf_parser::name_id::TYPOGRAPHIC_FAMILY)
                .or_else(|| font_name(&face, ttf_parser::name_id::FAMILY));
            let style = font_name(&face, ttf_parser::name_id::TYPOGRAPHIC_SUBFAMILY)
                .or_else(|| font_name(&face, ttf_parser::name_id::SUBFAMILY));
            let mut aliases = [
                ttf_parser::name_id::TYPOGRAPHIC_FAMILY,
                ttf_parser::name_id::FAMILY,
                ttf_parser::name_id::FULL_NAME,
                ttf_parser::name_id::POST_SCRIPT_NAME,
                ttf_parser::name_id::POST_SCRIPT_CID,
            ]
            .into_iter()
            .flat_map(|name_id| font_names(&face, name_id))
            .map(|alias| normalize_font_key(&alias))
            .filter(|alias| !alias.is_empty())
            .collect::<Vec<_>>();
            aliases.sort();
            aliases.dedup();
            Some(FontMetadata {
                face_index,
                family,
                style,
                aliases,
            })
        })
        .collect()
}

fn font_name(face: &ttf_parser::Face<'_>, name_id: u16) -> Option<String> {
    font_names(face, name_id).into_iter().next()
}

fn font_names(face: &ttf_parser::Face<'_>, name_id: u16) -> Vec<String> {
    // Some legacy ASS fonts use Windows encoding 2, which ttf-parser does not classify as a
    // Unicode name even though the SFNT payload is UTF-16BE. Decode all Microsoft names first,
    // then collect the remaining Unicode platforms.
    let mut names = windows_font_names(face, name_id);
    names.extend(
        face.names()
            .into_iter()
            .filter(|name| {
                name.name_id == name_id
                    && name.platform_id != ttf_parser::PlatformId::Windows
                    && name.is_unicode()
            })
            .filter_map(|name| name.to_string())
            .map(|name| name.trim().to_owned())
            .filter(|name| !name.is_empty()),
    );
    names.sort();
    names.dedup();
    names
}

fn windows_font_names(face: &ttf_parser::Face<'_>, name_id: u16) -> Vec<String> {
    let mut names = face
        .names()
        .into_iter()
        .filter(|name| {
            name.name_id == name_id && name.platform_id == ttf_parser::PlatformId::Windows
        })
        .filter_map(|name| {
            (name.name.len() % 2 == 0)
                .then(|| {
                    name.name
                        .chunks_exact(2)
                        .map(|bytes| u16::from_be_bytes([bytes[0], bytes[1]]))
                        .collect::<Vec<_>>()
                })
                .and_then(|units| String::from_utf16(&units).ok())
        })
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    names
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssMetadata {
    format: &'static str,
    cue_count: usize,
    style_count: usize,
    attachment_count: usize,
    play_res_x: i32,
    play_res_y: i32,
    layout_res_x: i32,
    layout_res_y: i32,
    wrap_style: i32,
    scaled_border_and_shadow: bool,
    language: String,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct AssEventData {
    start: f64,
    duration: f64,
    style: String,
    name: String,
    margin_l: i32,
    margin_r: i32,
    margin_v: i32,
    effect: String,
    text: String,
    read_order: i32,
    layer: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct AssStyleData {
    name: String,
    font_name: String,
    font_size: f64,
    primary_colour: u32,
    secondary_colour: u32,
    outline_colour: u32,
    back_colour: u32,
    bold: i32,
    italic: i32,
    underline: i32,
    strike_out: i32,
    scale_x: f64,
    scale_y: f64,
    spacing: f64,
    angle: f64,
    border_style: i32,
    outline: f64,
    shadow: f64,
    alignment: i32,
    margin_l: i32,
    margin_r: i32,
    margin_v: i32,
    encoding: i32,
    treat_fontname_as_pattern: i32,
    blur: f64,
    justify: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedAssPlane {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    stride: i32,
    color: u32,
    kind: i32,
    #[serde(with = "serde_bytes")]
    rgba: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedAssData {
    width: i32,
    height: i32,
    composition_data: Vec<RenderedAssPlane>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedAssFrameData {
    #[serde(with = "serde_bytes")]
    image_data: Vec<u8>,
    image_width: i32,
    image_height: i32,
    bounds: Option<AssCueBounds>,
    offset_x: i32,
    offset_y: i32,
    screen_width: i32,
    screen_height: i32,
    crop: &'static str,
    composition_count: usize,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssCueBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[wasm_bindgen]
pub struct AssParser {
    script: Script,
    renderer: Renderer,
}

#[wasm_bindgen]
impl AssParser {
    #[wasm_bindgen(constructor)]
    pub fn new(text: &str) -> Result<AssParser, JsValue> {
        let script = Script::parse(text).map_err(js_error)?;
        Ok(AssParser {
            script,
            renderer: Renderer::new(),
        })
    }

    #[wasm_bindgen(js_name = metadata)]
    pub fn metadata_js(&self) -> Result<JsValue, JsValue> {
        to_js(&metadata_for(&self.script))
    }

    #[wasm_bindgen(js_name = timestamps)]
    pub fn timestamps_js(&self) -> Vec<f64> {
        self.script
            .track()
            .events
            .iter()
            .map(|event| event.start as f64 / 1000.0)
            .collect()
    }

    #[wasm_bindgen(js_name = getEvents)]
    pub fn events_js(&self) -> Result<JsValue, JsValue> {
        let track = self.script.track();
        let events = track
            .events
            .iter()
            .map(|event| event_for(event, track.styles.get(event.style as usize)))
            .collect::<Vec<_>>();
        to_js(&events)
    }

    #[wasm_bindgen(js_name = getStyles)]
    pub fn styles_js(&self) -> Result<JsValue, JsValue> {
        let styles = self
            .script
            .track()
            .styles
            .iter()
            .map(style_for)
            .collect::<Vec<_>>();
        to_js(&styles)
    }

    #[wasm_bindgen(js_name = renderAtTimestamp)]
    pub fn render_at_timestamp_js(&self, time_seconds: f64) -> Result<JsValue, JsValue> {
        to_js(&self.render_at_ms(seconds_to_ass_ms(time_seconds))?)
    }

    #[wasm_bindgen(js_name = renderAtIndex)]
    pub fn render_at_index_js(&self, index: usize) -> Result<JsValue, JsValue> {
        let event = self
            .script
            .track()
            .events
            .get(index)
            .ok_or_else(|| JsValue::from_str("ASS event index out of range"))?;
        to_js(&self.render_at_ms(event.start)?)
    }

    #[wasm_bindgen(js_name = renderFrameDataAtTimestamp)]
    pub fn render_frame_data_at_timestamp_js(&self, time_seconds: f64) -> Result<JsValue, JsValue> {
        to_js(&self.render_frame_at_ms(seconds_to_ass_ms(time_seconds))?)
    }

    #[wasm_bindgen(js_name = renderFrameDataAtIndex)]
    pub fn render_frame_data_at_index_js(&self, index: usize) -> Result<JsValue, JsValue> {
        let event = self
            .script
            .track()
            .events
            .get(index)
            .ok_or_else(|| JsValue::from_str("ASS event index out of range"))?;
        to_js(&self.render_frame_at_ms(event.start)?)
    }

    #[wasm_bindgen(js_name = renderFrameBoundsDataAtTimestamp)]
    pub fn render_frame_bounds_data_at_timestamp_js(
        &self,
        time_seconds: f64,
    ) -> Result<JsValue, JsValue> {
        to_js(&self.render_frame_bounds_at_ms(seconds_to_ass_ms(time_seconds))?)
    }

    #[wasm_bindgen(js_name = renderFrameBoundsDataAtIndex)]
    pub fn render_frame_bounds_data_at_index_js(&self, index: usize) -> Result<JsValue, JsValue> {
        let event = self
            .script
            .track()
            .events
            .get(index)
            .ok_or_else(|| JsValue::from_str("ASS event index out of range"))?;
        to_js(&self.render_frame_bounds_at_ms(event.start)?)
    }

    #[wasm_bindgen(js_name = clearCache)]
    pub fn clear_cache(&mut self) {
        self.renderer = Renderer::new();
    }

    #[wasm_bindgen(js_name = dispose)]
    pub fn dispose(self) {}
}

#[wasm_bindgen(js_name = openAss)]
pub fn open_ass(text: &str) -> Result<AssParser, JsValue> {
    AssParser::new(text)
}

#[wasm_bindgen(js_name = detectSubtitleFormat)]
pub fn detect_subtitle_format(name_or_text: &str) -> String {
    let value = name_or_text.trim_start();
    if value.ends_with(".ass")
        || value.ends_with(".ssa")
        || value.starts_with("[Script Info]")
        || value.starts_with("[V4+ Styles]")
    {
        "ass".to_owned()
    } else {
        "unknown".to_owned()
    }
}

impl AssParser {
    fn render_raw_at_ms(&self, now_ms: i64) -> Result<rassa::Frame, JsValue> {
        let provider = RwssFontProvider::new();
        self.renderer
            .render_frame_with_provider(&self.script, &provider, now_ms)
            .map_err(js_error)
    }

    fn render_at_ms(&self, now_ms: i64) -> Result<RenderedAssData, JsValue> {
        let frame = self.render_raw_at_ms(now_ms)?;
        let size = self.script.play_res();
        Ok(RenderedAssData {
            width: size.width,
            height: size.height,
            composition_data: frame.planes.iter().map(plane_to_rendered).collect(),
        })
    }

    fn render_frame_at_ms(&self, now_ms: i64) -> Result<RenderedAssFrameData, JsValue> {
        let frame = self.render_raw_at_ms(now_ms)?;
        let size = self.script.play_res();
        flatten_image_planes(&frame.planes, size.width, size.height, FrameCrop::Screen)
    }

    fn render_frame_bounds_at_ms(&self, now_ms: i64) -> Result<RenderedAssFrameData, JsValue> {
        let frame = self.render_raw_at_ms(now_ms)?;
        let size = self.script.play_res();
        flatten_image_planes(&frame.planes, size.width, size.height, FrameCrop::Bounds)
    }
}

fn metadata_for(script: &Script) -> AssMetadata {
    let track = script.track();
    AssMetadata {
        format: "ass",
        cue_count: track.events.len(),
        style_count: track.styles.len(),
        attachment_count: track.attachments.len(),
        play_res_x: track.play_res_x,
        play_res_y: track.play_res_y,
        layout_res_x: track.layout_res_x,
        layout_res_y: track.layout_res_y,
        wrap_style: track.wrap_style,
        scaled_border_and_shadow: track.scaled_border_and_shadow,
        language: track.language.clone(),
    }
}

fn event_for(event: &ParsedEvent, style: Option<&ParsedStyle>) -> AssEventData {
    AssEventData {
        start: event.start as f64 / 1000.0,
        duration: event.duration as f64 / 1000.0,
        style: style
            .map(|style| style.name.clone())
            .unwrap_or_else(|| event.style.to_string()),
        name: event.name.clone(),
        margin_l: event.margin_l,
        margin_r: event.margin_r,
        margin_v: event.margin_v,
        effect: event.effect.clone(),
        text: event.text.clone(),
        read_order: event.read_order,
        layer: event.layer,
    }
}

fn style_for(style: &ParsedStyle) -> AssStyleData {
    AssStyleData {
        name: style.name.clone(),
        font_name: style.font_name.clone(),
        font_size: style.font_size,
        primary_colour: style.primary_colour,
        secondary_colour: style.secondary_colour,
        outline_colour: style.outline_colour,
        back_colour: style.back_colour,
        bold: if style.bold { -1 } else { 0 },
        italic: if style.italic { -1 } else { 0 },
        underline: if style.underline { -1 } else { 0 },
        strike_out: if style.strike_out { -1 } else { 0 },
        scale_x: style.scale_x,
        scale_y: style.scale_y,
        spacing: style.spacing,
        angle: style.angle,
        border_style: style.border_style,
        outline: style.outline,
        shadow: style.shadow,
        alignment: style.alignment,
        margin_l: style.margin_l,
        margin_r: style.margin_r,
        margin_v: style.margin_v,
        encoding: style.encoding,
        treat_fontname_as_pattern: style.treat_fontname_as_pattern,
        blur: style.blur,
        justify: style.justify,
    }
}

fn plane_to_rendered(plane: &ImagePlane) -> RenderedAssPlane {
    let color = plane.color.0;
    let red = ((color >> 24) & 0xff) as u8;
    let green = ((color >> 16) & 0xff) as u8;
    let blue = ((color >> 8) & 0xff) as u8;
    let inverse_alpha = (color & 0xff) as u8;
    let opacity = 255u8.saturating_sub(inverse_alpha);
    let width = plane.size.width.max(0) as usize;
    let height = plane.size.height.max(0) as usize;
    let rgba_len = width.saturating_mul(height).saturating_mul(4);
    let mut rgba = Vec::with_capacity(rgba_len);

    for row in 0..height {
        let source_row = row * plane.stride.max(0) as usize;
        for column in 0..width {
            let mask = plane.bitmap.get(source_row + column).copied().unwrap_or(0);
            let alpha = ((u16::from(mask) * u16::from(opacity) + 127) / 255) as u8;
            rgba.extend_from_slice(&[red, green, blue, alpha]);
        }
    }

    RenderedAssPlane {
        x: plane.destination.x,
        y: plane.destination.y,
        width: plane.size.width,
        height: plane.size.height,
        stride: plane.size.width.saturating_mul(4),
        color,
        kind: plane.kind as i32,
        rgba,
    }
}

#[derive(Clone, Copy)]
enum FrameCrop {
    Screen,
    Bounds,
}

fn visible_bounds_for_image_planes(
    planes: &[ImagePlane],
    screen_width: i32,
    screen_height: i32,
) -> Option<AssCueBounds> {
    let screen_width = i64::from(screen_width.max(0));
    let screen_height = i64::from(screen_height.max(0));
    let mut x_min = screen_width;
    let mut y_min = screen_height;
    let mut x_max = 0i64;
    let mut y_max = 0i64;
    for plane in planes
        .iter()
        .filter(|plane| plane.size.width > 0 && plane.size.height > 0)
    {
        let plane_x_min = i64::from(plane.destination.x).clamp(0, screen_width);
        let plane_y_min = i64::from(plane.destination.y).clamp(0, screen_height);
        let plane_x_max =
            (i64::from(plane.destination.x) + i64::from(plane.size.width)).clamp(0, screen_width);
        let plane_y_max =
            (i64::from(plane.destination.y) + i64::from(plane.size.height)).clamp(0, screen_height);
        if plane_x_min >= plane_x_max || plane_y_min >= plane_y_max {
            continue;
        }
        x_min = x_min.min(plane_x_min);
        y_min = y_min.min(plane_y_min);
        x_max = x_max.max(plane_x_max);
        y_max = y_max.max(plane_y_max);
    }
    if x_min < x_max && y_min < y_max {
        Some(AssCueBounds {
            x: x_min as i32,
            y: y_min as i32,
            width: (x_max - x_min) as i32,
            height: (y_max - y_min) as i32,
        })
    } else {
        None
    }
}

fn flatten_image_planes(
    planes: &[ImagePlane],
    screen_width: i32,
    screen_height: i32,
    crop: FrameCrop,
) -> Result<RenderedAssFrameData, JsValue> {
    let bounds = visible_bounds_for_image_planes(planes, screen_width, screen_height);
    let composition_count = if bounds.is_some() { planes.len() } else { 0 };
    let (offset_x, offset_y, image_width, image_height, crop_name) = match (crop, bounds) {
        (FrameCrop::Screen, Some(_)) => (0, 0, screen_width.max(0), screen_height.max(0), "screen"),
        (FrameCrop::Bounds, Some(bounds)) => {
            (bounds.x, bounds.y, bounds.width, bounds.height, "bounds")
        }
        (FrameCrop::Screen, None) => (0, 0, 0, 0, "screen"),
        (FrameCrop::Bounds, None) => (0, 0, 0, 0, "bounds"),
    };
    let mut image_data = if composition_count == 0 {
        Vec::new()
    } else {
        vec![0; rgba_buffer_len(image_width, image_height)?]
    };
    for plane in planes {
        blend_image_plane_with_origin(
            &mut image_data,
            image_width,
            image_height,
            offset_x,
            offset_y,
            plane,
        );
    }
    Ok(RenderedAssFrameData {
        image_data,
        image_width,
        image_height,
        bounds,
        offset_x,
        offset_y,
        screen_width,
        screen_height,
        crop: crop_name,
        composition_count,
    })
}

fn rgba_buffer_len(width: i32, height: i32) -> Result<usize, JsValue> {
    if width <= 0 || height <= 0 {
        return Ok(0);
    }
    let width = usize::try_from(width).map_err(js_error)?;
    let height = usize::try_from(height).map_err(js_error)?;
    width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| JsValue::from_str("ASS frame dimensions exceed addressable memory"))
}

#[cfg(test)]
fn blend_image_plane(target: &mut [u8], target_width: i32, target_height: i32, plane: &ImagePlane) {
    blend_image_plane_with_origin(target, target_width, target_height, 0, 0, plane);
}

fn blend_image_plane_with_origin(
    target: &mut [u8],
    target_width: i32,
    target_height: i32,
    target_origin_x: i32,
    target_origin_y: i32,
    plane: &ImagePlane,
) {
    if target_width <= 0 || target_height <= 0 || plane.size.width <= 0 || plane.size.height <= 0 {
        return;
    }

    let color = plane.color.0;
    let red = ((color >> 24) & 0xff) as u8;
    let green = ((color >> 16) & 0xff) as u8;
    let blue = ((color >> 8) & 0xff) as u8;
    let opacity = 255u8.saturating_sub((color & 0xff) as u8);
    let plane_width = i64::from(plane.size.width);
    let plane_height = i64::from(plane.size.height);
    let destination_origin_x = i64::from(plane.destination.x) - i64::from(target_origin_x);
    let destination_origin_y = i64::from(plane.destination.y) - i64::from(target_origin_y);
    let source_x_start = (-destination_origin_x).max(0).min(plane_width);
    let source_y_start = (-destination_origin_y).max(0).min(plane_height);
    let source_x_end = (i64::from(target_width) - destination_origin_x)
        .max(0)
        .min(plane_width);
    let source_y_end = (i64::from(target_height) - destination_origin_y)
        .max(0)
        .min(plane_height);
    if source_x_start >= source_x_end || source_y_start >= source_y_end {
        return;
    }

    let stride = plane.stride.max(0) as usize;
    let target_width = target_width as usize;
    for source_y in source_y_start as usize..source_y_end as usize {
        let destination_y = (destination_origin_y + source_y as i64) as usize;
        let source_row = source_y.saturating_mul(stride);
        let destination_row = destination_y.saturating_mul(target_width);
        for source_x in source_x_start as usize..source_x_end as usize {
            let mask = plane
                .bitmap
                .get(source_row.saturating_add(source_x))
                .copied()
                .unwrap_or(0);
            let source_alpha = ((u16::from(mask) * u16::from(opacity) + 127) / 255) as u8;
            if source_alpha == 0 {
                continue;
            }
            let destination_x = (destination_origin_x + source_x as i64) as usize;
            let destination = destination_row
                .saturating_add(destination_x)
                .saturating_mul(4);
            if destination.saturating_add(3) >= target.len() {
                continue;
            }
            blend_pixel(target, destination, [red, green, blue], source_alpha);
        }
    }
}

fn blend_pixel(target: &mut [u8], destination: usize, source_rgb: [u8; 3], source_alpha: u8) {
    let destination_alpha = target[destination + 3];
    if source_alpha == 255 || destination_alpha == 0 {
        target[destination..destination + 3].copy_from_slice(&source_rgb);
        target[destination + 3] = source_alpha;
        return;
    }

    let source_alpha_float = f32::from(source_alpha) / 255.0;
    let destination_alpha_float = f32::from(destination_alpha) / 255.0;
    let output_alpha = source_alpha_float + destination_alpha_float * (1.0 - source_alpha_float);
    for channel in 0..3 {
        let source_value = f32::from(source_rgb[channel]) / 255.0;
        let destination_value = f32::from(target[destination + channel]) / 255.0;
        let output = (source_value * source_alpha_float
            + destination_value * destination_alpha_float * (1.0 - source_alpha_float))
            / output_alpha;
        target[destination + channel] = (output * 255.0).round().clamp(0.0, 255.0) as u8;
    }
    target[destination + 3] = (output_alpha * 255.0).round().clamp(0.0, 255.0) as u8;
}

#[cfg(test)]
fn blend_plane(target: &mut [u8], target_width: i32, target_height: i32, plane: &RenderedAssPlane) {
    if target_width <= 0 || target_height <= 0 || plane.width <= 0 || plane.height <= 0 {
        return;
    }
    for y in 0..plane.height {
        let dst_y = plane.y + y;
        if !(0..target_height).contains(&dst_y) {
            continue;
        }
        for x in 0..plane.width {
            let dst_x = plane.x + x;
            if !(0..target_width).contains(&dst_x) {
                continue;
            }
            let src = ((y * plane.width + x) * 4) as usize;
            let dst = ((dst_y * target_width + dst_x) * 4) as usize;
            let src_alpha = f32::from(plane.rgba[src + 3]) / 255.0;
            let dst_alpha = f32::from(target[dst + 3]) / 255.0;
            let out_alpha = src_alpha + dst_alpha * (1.0 - src_alpha);
            if out_alpha <= 0.0 {
                continue;
            }
            for channel in 0..3 {
                let src_value = f32::from(plane.rgba[src + channel]) / 255.0;
                let dst_value = f32::from(target[dst + channel]) / 255.0;
                let out =
                    (src_value * src_alpha + dst_value * dst_alpha * (1.0 - src_alpha)) / out_alpha;
                target[dst + channel] = (out * 255.0).round().clamp(0.0, 255.0) as u8;
            }
            target[dst + 3] = (out_alpha * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }
}

fn seconds_to_ass_ms(seconds: f64) -> i64 {
    if !seconds.is_finite() {
        return 0;
    }

    let raw_milliseconds = seconds * 1000.0;
    let nearest_millisecond = raw_milliseconds.round();
    let magnitude = if raw_milliseconds.abs() > 1.0 {
        raw_milliseconds.abs()
    } else {
        1.0
    };
    let round_off_tolerance = magnitude * f64::EPSILON * 4.0;
    let milliseconds = if (raw_milliseconds - nearest_millisecond).abs() <= round_off_tolerance {
        nearest_millisecond
    } else {
        raw_milliseconds.floor()
    };

    milliseconds.clamp(i64::MIN as f64, i64::MAX as f64) as i64
}

fn to_js<T: Serialize + ?Sized>(value: &T) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(value).map_err(js_error)
}

fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "[Script Info]\nPlayResX: 320\nPlayResY: 180\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,sans,24,&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,rwss";

    #[test]
    fn parses_metadata_and_events() {
        let parser = AssParser::new(SAMPLE).expect("sample parses");
        let metadata = metadata_for(&parser.script);
        assert_eq!(metadata.format, "ass");
        assert_eq!(metadata.play_res_x, 320);
        assert_eq!(metadata.play_res_y, 180);
        assert_eq!(metadata.cue_count, 1);
        assert_eq!(parser.timestamps_js(), vec![0.0]);
    }

    #[test]
    fn renders_screen_frame_shape() {
        let parser = AssParser::new(SAMPLE).expect("sample parses");
        let frame = parser.render_frame_at_ms(500).expect("render succeeds");
        assert_eq!(frame.screen_width, 320);
        assert_eq!(frame.screen_height, 180);
        assert_eq!(frame.image_width, 320);
        assert_eq!(frame.image_height, 180);
        assert_eq!(frame.image_data.len(), 320 * 180 * 4);
    }

    #[test]
    fn empty_frame_omits_the_full_screen_pixel_buffer() {
        let parser = AssParser::new(SAMPLE).expect("sample parses");
        let frame = parser.render_frame_at_ms(2_000).expect("render succeeds");

        assert_eq!(frame.screen_width, 320);
        assert_eq!(frame.screen_height, 180);
        assert_eq!(frame.image_width, 0);
        assert_eq!(frame.image_height, 0);
        assert_eq!(frame.composition_count, 0);
        assert!(frame.image_data.is_empty());
    }

    #[test]
    fn preserves_exact_integer_milliseconds() {
        assert_eq!(seconds_to_ass_ms(1.001), 1001);
        assert_eq!(seconds_to_ass_ms(8.008), 8008);
        assert_eq!(seconds_to_ass_ms(0.0), 0);
        assert_eq!(seconds_to_ass_ms(1.0015), 1001);
        assert_eq!(seconds_to_ass_ms(f64::NAN), 0);
    }

    #[test]
    fn decodes_the_bundled_woff2_font() {
        let compressed = include_bytes!("default.woff2");
        let decoded = normalize_font_bytes(compressed.to_vec()).expect("WOFF2 decodes");

        assert_ne!(decoded.get(..4), Some(b"wOF2".as_slice()));
        assert!(decoded.len() <= MAX_FONT_BYTES);
        assert!(!font_metadata_from_bytes(&decoded).is_empty());
    }

    #[test]
    fn rejects_compressed_fonts_with_oversized_declared_output() {
        let mut compressed = include_bytes!("default.woff2").to_vec();
        compressed[16..20].copy_from_slice(&((MAX_FONT_BYTES as u32) + 1).to_be_bytes());

        let error = normalize_font_bytes(compressed).expect_err("oversized font is rejected");
        assert!(error.contains("32 MiB"));
    }

    #[test]
    fn font_provider_cache_key_is_stable_per_snapshot_and_unique_after_mutation() {
        let snapshot = Arc::new(FontRegistrySnapshot::default());
        let first = RwssFontProvider {
            snapshot: snapshot.clone(),
        };
        let same_snapshot = RwssFontProvider { snapshot };
        let changed_snapshot = RwssFontProvider {
            snapshot: Arc::new(FontRegistrySnapshot::default()),
        };

        assert_eq!(first.layout_cache_key(), same_snapshot.layout_cache_key());
        assert_ne!(
            first.layout_cache_key(),
            changed_snapshot.layout_cache_key()
        );
    }

    #[test]
    fn exact_family_prefers_newest_non_fallback_record() {
        let records = vec![
            test_font_record("/attached-old", "Regular", false),
            test_font_record("/attached-new", "Regular", false),
            test_font_record("/available-newest", "Italic", true),
        ];
        let provider = provider_with_records(records);

        let unstyled = provider.resolve(&FontQuery::new("shared family"));
        assert_eq!(unstyled.path, Some(PathBuf::from("/attached-new")));

        let italic = provider.resolve(&FontQuery::new("shared family").with_style("Italic"));
        assert_eq!(italic.path, Some(PathBuf::from("/attached-new")));
        assert!(italic.synthetic_italic);
    }

    #[test]
    fn exact_family_uses_newest_fallback_when_no_attached_font_exists() {
        let provider = provider_with_records(vec![
            test_font_record("/available-old", "Regular", true),
            test_font_record("/available-new", "Regular", true),
        ]);

        let resolved = provider.resolve(&FontQuery::new("shared family"));
        assert_eq!(resolved.path, Some(PathBuf::from("/available-new")));
    }

    #[test]
    fn text_resolution_skips_a_matching_font_without_the_required_glyphs() {
        let decoded = normalize_font_bytes(include_bytes!("default.woff2").to_vec())
            .expect("bundled WOFF2 decodes");
        let path = PathBuf::from("/rwss-test-fonts/bundled-default");
        register_virtual_font_bytes(path.clone(), decoded);
        let provider = provider_with_records(vec![
            test_font_record("/rwss-test-fonts/missing", "Regular", false),
            VirtualFontRecord {
                path: path.clone(),
                is_fallback: true,
                ..test_font_record("/unused", "Regular", true)
            },
        ]);

        let resolved = provider.resolve_for_text(&FontQuery::new("shared family"), "rwss");
        assert_eq!(resolved.path, Some(path));
    }

    #[test]
    fn exported_plane_stride_matches_its_rgba_layout() {
        let plane = test_image_plane(0x1020_3000, rassa::Point { x: 0, y: 0 });
        let rendered = plane_to_rendered(&plane);

        assert_eq!(rendered.stride, rendered.width * 4);
        assert_eq!(
            rendered.rgba.len(),
            (rendered.stride * rendered.height) as usize
        );
    }

    #[test]
    fn direct_mask_blending_matches_the_rgba_reference_path() {
        for (color, destination) in [
            (0xa040_2000, rassa::Point { x: -1, y: 1 }),
            (0x10d0_7080, rassa::Point { x: 3, y: -1 }),
        ] {
            let plane = test_image_plane(color, destination);
            let rendered = plane_to_rendered(&plane);
            let mut reference = (0..5 * 4 * 4)
                .map(|index| ((index * 37 + 11) % 256) as u8)
                .collect::<Vec<_>>();
            let mut direct = reference.clone();

            blend_plane(&mut reference, 5, 4, &rendered);
            blend_image_plane(&mut direct, 5, 4, &plane);

            assert_eq!(direct, reference);
        }
    }

    #[test]
    fn bounds_crop_flattens_only_the_clamped_visible_rectangle() {
        let plane = test_image_plane(0xa040_2000, rassa::Point { x: -1, y: 1 });
        let screen = flatten_image_planes(std::slice::from_ref(&plane), 5, 4, FrameCrop::Screen)
            .expect("screen flatten succeeds");
        let cropped = flatten_image_planes(std::slice::from_ref(&plane), 5, 4, FrameCrop::Bounds)
            .expect("bounds flatten succeeds");
        let bounds = cropped.bounds.expect("plane has visible bounds");

        assert_eq!(
            (bounds.x, bounds.y, bounds.width, bounds.height),
            (0, 1, 3, 3)
        );
        assert_eq!((cropped.offset_x, cropped.offset_y), (0, 1));
        assert_eq!((cropped.image_width, cropped.image_height), (3, 3));
        assert_eq!(cropped.image_data.len(), 3 * 3 * 4);

        for y in 0..cropped.image_height as usize {
            for x in 0..cropped.image_width as usize {
                let cropped_pixel = (y * cropped.image_width as usize + x) * 4;
                let screen_pixel =
                    ((y + cropped.offset_y as usize) * screen.image_width as usize + x) * 4;
                assert_eq!(
                    &cropped.image_data[cropped_pixel..cropped_pixel + 4],
                    &screen.image_data[screen_pixel..screen_pixel + 4]
                );
            }
        }
    }

    fn provider_with_records(records: Vec<VirtualFontRecord>) -> RwssFontProvider {
        RwssFontProvider {
            snapshot: Arc::new(FontRegistrySnapshot {
                virtual_fonts: records,
                fallback_families: Vec::new(),
                layout_cache_key: FontProviderCacheKey::new(),
            }),
        }
    }

    fn test_font_record(path: &str, style: &str, is_fallback: bool) -> VirtualFontRecord {
        VirtualFontRecord {
            family: "Shared Family".to_owned(),
            aliases: vec![normalize_font_key("Shared Family")],
            path: PathBuf::from(path),
            face_index: None,
            style: Some(style.to_owned()),
            style_key: Some(normalize_font_key(style)),
            is_fallback,
        }
    }

    fn test_image_plane(color: u32, destination: rassa::Point) -> ImagePlane {
        ImagePlane {
            size: rassa::Size {
                width: 4,
                height: 3,
            },
            stride: 6,
            color: rassa::RgbaColor(color),
            destination,
            kind: rassa::ass::ImageType::Character,
            bitmap: vec![
                0, 32, 128, 255, 9, 9, 255, 191, 64, 0, 9, 9, 17, 85, 170, 238, 9, 9,
            ],
        }
    }
}
