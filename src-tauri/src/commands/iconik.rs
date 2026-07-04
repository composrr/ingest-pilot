// iconik REST API client: connects the app to the user's iconik instance so
// metadata can be written directly onto assets (no sidecars, no CSV, no touching
// the media files). Auth is App-ID + Auth-Token headers on every request.
//
// Endpoints used:
//   GET  {base}/API/metadata/v1/views/                          list metadata views
//   GET  {base}/API/metadata/v1/views/{view_id}/                a view's fields
//   POST {base}/API/search/v1/search/                           find an asset by title
//   PUT  {base}/API/metadata/v1/assets/{id}/views/{view_id}/    set an asset's metadata

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Duration;

#[derive(Debug, Clone, Deserialize)]
pub struct IconikConfig {
    pub base_url: String,
    pub app_id: String,
    pub auth_token: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct IconikView {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct IconikField {
    pub name: String,
    pub label: String,
    pub field_type: String,
}

/// One asset to tag: matched to an iconik asset by `title` (the file/clip name),
/// then `values` (field name -> list of string values) is written to the view.
#[derive(Debug, Clone, Deserialize)]
pub struct IconikPushItem {
    pub title: String,
    pub values: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IconikPushResult {
    pub title: String,
    pub status: String,
    pub detail: Option<String>,
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())
}

fn base(config: &IconikConfig) -> String {
    config.base_url.trim().trim_end_matches('/').to_string()
}

fn get(config: &IconikConfig, path: &str) -> Result<Value, String> {
    let response = client()?
        .get(format!("{}{path}", base(config)))
        .header("App-ID", config.app_id.trim())
        .header("Auth-Token", config.auth_token.trim())
        .header("Accept", "application/json")
        .send()
        .map_err(|error| format!("iconik request failed: {error}"))?;
    parse_json(response)
}

fn parse_json(response: reqwest::blocking::Response) -> Result<Value, String> {
    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => "iconik rejected the credentials (check App-ID and Auth-Token).".to_string(),
            404 => "iconik endpoint not found (check the Base URL).".to_string(),
            _ => format!("iconik returned {status}: {}", text.chars().take(200).collect::<String>()),
        });
    }
    serde_json::from_str(&text).map_err(|error| format!("iconik sent a response we couldn't read: {error}"))
}

/// Lists the metadata views on the connected iconik instance. Doubles as a
/// connection/credentials test.
#[tauri::command]
pub fn iconik_list_views(config: IconikConfig) -> Result<Vec<IconikView>, String> {
    let body = get(&config, "/API/metadata/v1/views/")?;
    let objects = body
        .get("objects")
        .and_then(Value::as_array)
        .ok_or_else(|| "iconik returned no views.".to_string())?;
    let mut views: Vec<IconikView> = objects
        .iter()
        .filter_map(|view| {
            Some(IconikView {
                id: view.get("id")?.as_str()?.to_string(),
                name: view.get("name")?.as_str()?.to_string(),
            })
        })
        .collect();
    views.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(views)
}

/// Returns a view's fields (name/label/type) so the app can map its metadata to the
/// exact field names iconik expects.
#[tauri::command]
pub fn iconik_view_fields(config: IconikConfig, view_id: String) -> Result<Vec<IconikField>, String> {
    let body = get(&config, &format!("/API/metadata/v1/views/{view_id}/"))?;
    let fields = body
        .get("view_fields")
        .and_then(Value::as_array)
        .ok_or_else(|| "iconik view has no fields.".to_string())?;
    Ok(fields
        .iter()
        .filter_map(|field| {
            let name = field.get("name")?.as_str()?.to_string();
            Some(IconikField {
                label: field
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or(&name)
                    .to_string(),
                field_type: field
                    .get("field_type")
                    .and_then(Value::as_str)
                    .unwrap_or("string")
                    .to_string(),
                name,
            })
        })
        .collect())
}

/// Finds the iconik asset id whose title best matches `title` (exact, case-insensitive
/// preferred; otherwise the first search hit). Returns None if nothing matches.
fn find_asset_id(config: &IconikConfig, title: &str) -> Result<Option<String>, String> {
    let response = client()?
        .post(format!("{}/API/search/v1/search/", base(config)))
        .header("App-ID", config.app_id.trim())
        .header("Auth-Token", config.auth_token.trim())
        .header("Content-Type", "application/json")
        .json(&json!({
            "doc_types": ["assets"],
            "query": title,
            "per_page": 20,
        }))
        .send()
        .map_err(|error| format!("iconik search failed: {error}"))?;
    let body = parse_json(response)?;
    let objects = match body.get("objects").and_then(Value::as_array) {
        Some(objects) => objects,
        None => return Ok(None),
    };
    let wanted = title.to_lowercase();
    // Prefer an exact (case-insensitive) title match; fall back to the first hit.
    let exact = objects.iter().find(|object| {
        object
            .get("title")
            .and_then(Value::as_str)
            .map(|value| value.to_lowercase() == wanted)
            .unwrap_or(false)
    });
    let chosen = exact.or_else(|| objects.first());
    Ok(chosen
        .and_then(|object| object.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string))
}

fn set_metadata(
    config: &IconikConfig,
    asset_id: &str,
    view_id: &str,
    values: &BTreeMap<String, Vec<String>>,
) -> Result<(), String> {
    let mut metadata_values = serde_json::Map::new();
    for (field, entries) in values {
        if entries.iter().all(|value| value.trim().is_empty()) {
            continue;
        }
        metadata_values.insert(
            field.clone(),
            json!({
                "field_values": entries
                    .iter()
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| json!({ "value": value }))
                    .collect::<Vec<_>>(),
            }),
        );
    }
    let response = client()?
        .put(format!(
            "{}/API/metadata/v1/assets/{asset_id}/views/{view_id}/",
            base(config)
        ))
        .header("App-ID", config.app_id.trim())
        .header("Auth-Token", config.auth_token.trim())
        .header("Content-Type", "application/json")
        .json(&json!({ "metadata_values": metadata_values }))
        .send()
        .map_err(|error| format!("iconik metadata write failed: {error}"))?;
    parse_json(response).map(|_| ())
}

/// Tags each item onto its matching iconik asset. Assets that iconik hasn't scanned
/// yet come back as "not_found" so the caller can retry.
#[tauri::command]
pub fn iconik_push_metadata(
    config: IconikConfig,
    view_id: String,
    items: Vec<IconikPushItem>,
) -> Result<Vec<IconikPushResult>, String> {
    let mut results = Vec::with_capacity(items.len());
    for item in items {
        let result = match find_asset_id(&config, &item.title) {
            Ok(Some(asset_id)) => match set_metadata(&config, &asset_id, &view_id, &item.values) {
                Ok(()) => IconikPushResult {
                    title: item.title,
                    status: "updated".to_string(),
                    detail: None,
                },
                Err(error) => IconikPushResult {
                    title: item.title,
                    status: "error".to_string(),
                    detail: Some(error),
                },
            },
            Ok(None) => IconikPushResult {
                title: item.title,
                status: "not_found".to_string(),
                detail: Some("No matching asset in iconik yet.".to_string()),
            },
            Err(error) => IconikPushResult {
                title: item.title,
                status: "error".to_string(),
                detail: Some(error),
            },
        };
        results.push(result);
    }
    Ok(results)
}
