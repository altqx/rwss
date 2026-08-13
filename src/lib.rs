//! # rwss
//!
//! Browser-friendly WASM facade for rendering ASS/SSA subtitles with rassa.

use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

use rassa::{
    FontProvider, FontconfigProvider, ImagePlane, ParsedEvent, ParsedStyle, Renderer, Script,
};
use rassa_fonts::{FontMatch, FontProviderKind, FontQuery};
use rassa_shape::register_virtual_font_bytes;
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
    style: Option<String>,
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

static VIRTUAL_FONTS: OnceLock<Mutex<Vec<VirtualFontRecord>>> = OnceLock::new();
static FALLBACK_FAMILIES: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

fn virtual_fonts() -> &'static Mutex<Vec<VirtualFontRecord>> {
    VIRTUAL_FONTS.get_or_init(|| Mutex::new(Vec::new()))
}

fn fallback_families() -> &'static Mutex<Vec<String>> {
    FALLBACK_FAMILIES.get_or_init(|| Mutex::new(Vec::new()))
}

struct RwssFontProvider {
    virtual_fonts: Vec<VirtualFontRecord>,
    system: FontconfigProvider,
}

impl RwssFontProvider {
    fn new() -> Self {
        Self {
            virtual_fonts: virtual_fonts()
                .lock()
                .expect("virtual font registry mutex poisoned")
                .clone(),
            system: FontconfigProvider::new(),
        }
    }
}

impl FontProvider for RwssFontProvider {
    fn resolve(&self, query: &FontQuery) -> FontMatch {
        let family_key = normalize_font_key(&query.family);
        let style_key = query.style.as_deref().map(normalize_font_key);
        let exact = self.virtual_fonts.iter().find(|font| {
            font.aliases.iter().any(|alias| alias == &family_key)
                && style_key.as_ref().is_none_or(|style| {
                    font.style.as_deref().map(normalize_font_key).as_ref() == Some(style)
                })
        });
        let fallback = self
            .virtual_fonts
            .iter()
            .find(|font| font.aliases.iter().any(|alias| alias == &family_key));

        if let Some(font) = exact.or(fallback) {
            return font_match_from_record(font, query);
        }

        if let Some(font) = self.resolve_configured_fallback(query) {
            return font;
        }

        if let Some(font) = self
            .virtual_fonts
            .iter()
            .find(|font| !font.is_fallback)
            .or_else(|| self.virtual_fonts.iter().find(|font| font.is_fallback))
            .or_else(|| self.virtual_fonts.first())
        {
            return font_match_from_record(font, query);
        }

        self.system.resolve(query)
    }
}

impl RwssFontProvider {
    fn resolve_configured_fallback(&self, query: &FontQuery) -> Option<FontMatch> {
        let fallback_keys = fallback_families()
            .lock()
            .expect("fallback font registry mutex poisoned")
            .clone();
        for family_key in fallback_keys {
            if let Some(font) = self
                .virtual_fonts
                .iter()
                .find(|font| font.aliases.iter().any(|alias| alias == &family_key))
            {
                return Some(font_match_from_record(font, query));
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
        face_index: None,
        style: font.style.clone().or_else(|| query.style.clone()),
        synthetic_bold,
        synthetic_italic,
        provider: FontProviderKind::Attached,
    }
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
    *fallback_families()
        .lock()
        .expect("fallback font registry mutex poisoned") = normalized;
    Ok(())
}

fn register_font_inner(
    name_hint: Option<&str>,
    bytes: Vec<u8>,
    options: Option<JsValue>,
) -> Result<String, JsValue> {
    if bytes.is_empty() {
        return Err(JsValue::from_str("Font bytes must not be empty"));
    }
    let options = options
        .map(serde_wasm_bindgen::from_value::<RegisterFontOptions>)
        .transpose()
        .map_err(js_error)?;
    let metadata = font_metadata_from_bytes(&bytes);
    let family = options
        .as_ref()
        .and_then(|options| options.name.as_deref())
        .or(name_hint)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .or_else(|| metadata.as_ref().map(|(family, _)| family.clone()))
        .unwrap_or_else(|| "font".to_owned());
    let style = options
        .as_ref()
        .and_then(|options| options.style.clone())
        .or_else(|| metadata.as_ref().and_then(|(_, style)| style.clone()));
    let mut aliases = vec![normalize_font_key(&family)];
    if let Some(name_hint) = name_hint {
        aliases.push(normalize_font_key(name_hint));
    }
    if let Some((metadata_family, _)) = &metadata {
        aliases.push(normalize_font_key(metadata_family));
    }
    aliases.extend(
        options
            .as_ref()
            .and_then(|options| options.aliases.as_ref())
            .into_iter()
            .flatten()
            .map(|alias| normalize_font_key(alias.trim_start_matches('@'))),
    );
    aliases.retain(|alias| !alias.is_empty());
    aliases.sort();
    aliases.dedup();
    let path = PathBuf::from(format!(
        "/rwss-fontconfig/{:016x}-{}",
        stable_font_hash(&family, &bytes),
        sanitize_font_name(&family)
    ));
    register_virtual_font_bytes(path.clone(), bytes);
    let record = VirtualFontRecord {
        family,
        aliases,
        path: path.clone(),
        style,
        is_fallback: options
            .as_ref()
            .and_then(|options| options.is_fallback)
            .unwrap_or(false),
    };
    let mut registry = virtual_fonts()
        .lock()
        .expect("virtual font registry mutex poisoned");
    registry.retain(|font| font.path != record.path);
    registry.push(record);
    Ok(path.to_string_lossy().into_owned())
}

#[wasm_bindgen(js_name = clearRegisteredFonts)]
pub fn clear_registered_fonts() {
    virtual_fonts()
        .lock()
        .expect("virtual font registry mutex poisoned")
        .clear();
    fallback_families()
        .lock()
        .expect("fallback font registry mutex poisoned")
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

    let fonts = virtual_fonts()
        .lock()
        .expect("virtual font registry mutex poisoned")
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

fn font_metadata_from_bytes(bytes: &[u8]) -> Option<(String, Option<String>)> {
    let face = ttf_parser::Face::parse(bytes, 0).ok()?;
    let family = font_name(&face, ttf_parser::name_id::TYPOGRAPHIC_FAMILY)
        .or_else(|| font_name(&face, ttf_parser::name_id::FAMILY))?;
    let style = font_name(&face, ttf_parser::name_id::TYPOGRAPHIC_SUBFAMILY)
        .or_else(|| font_name(&face, ttf_parser::name_id::SUBFAMILY));
    Some((family, style))
}

fn font_name(face: &ttf_parser::Face<'_>, name_id: u16) -> Option<String> {
    face.names()
        .into_iter()
        .find(|name| name.name_id == name_id && name.is_unicode())
        .and_then(|name| name.to_string())
        .filter(|name| !name.trim().is_empty())
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
    image_data: Vec<u8>,
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
    fn render_at_ms(&self, now_ms: i64) -> Result<RenderedAssData, JsValue> {
        let provider = RwssFontProvider::new();
        let frame = self
            .renderer
            .render_frame_with_provider(&self.script, &provider, now_ms)
            .map_err(js_error)?;
        let size = self.script.play_res();
        Ok(RenderedAssData {
            width: size.width,
            height: size.height,
            composition_data: frame.planes.iter().map(plane_to_rendered).collect(),
        })
    }

    fn render_frame_at_ms(&self, now_ms: i64) -> Result<RenderedAssFrameData, JsValue> {
        let data = self.render_at_ms(now_ms)?;
        let bounds = bounds_for_planes(&data.composition_data);
        let screen_width = data.width;
        let screen_height = data.height;
        let mut image_data = vec![0; (screen_width.max(0) * screen_height.max(0) * 4) as usize];
        for plane in &data.composition_data {
            blend_plane(&mut image_data, screen_width, screen_height, plane);
        }
        Ok(RenderedAssFrameData {
            image_data,
            bounds,
            offset_x: 0,
            offset_y: 0,
            screen_width,
            screen_height,
            crop: "screen",
            composition_count: data.composition_data.len(),
        })
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
    let pixel_count = (plane.size.width.max(0) * plane.size.height.max(0)) as usize;
    let mut rgba = Vec::with_capacity(pixel_count * 4);

    for row in 0..plane.size.height.max(0) as usize {
        let source_row = row * plane.stride.max(0) as usize;
        for column in 0..plane.size.width.max(0) as usize {
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
        stride: plane.stride,
        color,
        kind: plane.kind as i32,
        rgba,
    }
}

fn bounds_for_planes(planes: &[RenderedAssPlane]) -> Option<AssCueBounds> {
    let mut x_min = i32::MAX;
    let mut y_min = i32::MAX;
    let mut x_max = i32::MIN;
    let mut y_max = i32::MIN;
    for plane in planes
        .iter()
        .filter(|plane| plane.width > 0 && plane.height > 0)
    {
        x_min = x_min.min(plane.x);
        y_min = y_min.min(plane.y);
        x_max = x_max.max(plane.x + plane.width);
        y_max = y_max.max(plane.y + plane.height);
    }
    (x_min < x_max && y_min < y_max).then_some(AssCueBounds {
        x: x_min,
        y: y_min,
        width: x_max - x_min,
        height: y_max - y_min,
    })
}

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
        assert_eq!(frame.image_data.len(), 320 * 180 * 4);
    }

    #[test]
    fn preserves_exact_integer_milliseconds() {
        assert_eq!(seconds_to_ass_ms(1.001), 1001);
        assert_eq!(seconds_to_ass_ms(8.008), 8008);
        assert_eq!(seconds_to_ass_ms(0.0), 0);
        assert_eq!(seconds_to_ass_ms(1.0015), 1001);
        assert_eq!(seconds_to_ass_ms(f64::NAN), 0);
    }
}
