//! 频道消息加密：照 FoxNudge 用 XChaCha20-Poly1305，共享密钥经 SHA-256 派生成 32 字节
//! 密文格式 fsx1.<base64url(nonce 24 字节 + 密文)>；派生时加了 fox-sync 前缀，和 FoxNudge 的消息互相解不开
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};

pub const PREFIX: &str = "fsx1.";

fn cipher(secret: &str) -> XChaCha20Poly1305 {
    let digest = Sha256::digest(format!("fox-sync/v1/{}", secret.trim()).as_bytes());
    XChaCha20Poly1305::new_from_slice(&digest).expect("32 字节密钥")
}

pub fn seal<T: Serialize>(secret: &str, payload: &T) -> Result<String, String> {
    let plain = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
    let mut nonce = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce);
    let sealed = cipher(secret)
        .encrypt(XNonce::from_slice(&nonce), plain.as_slice())
        .map_err(|_| "加密失败".to_string())?;
    let mut out = nonce.to_vec();
    out.extend(sealed);
    Ok(format!("{PREFIX}{}", B64.encode(out)))
}

pub fn open<T: DeserializeOwned>(secret: &str, text: &str) -> Option<T> {
    let raw = B64.decode(text.strip_prefix(PREFIX)?.trim()).ok()?;
    if raw.len() < 24 + 16 {
        return None;
    }
    let (nonce, sealed) = raw.split_at(24);
    let plain = cipher(secret).decrypt(XNonce::from_slice(nonce), sealed).ok()?;
    serde_json::from_slice(&plain).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    #[test]
    fn roundtrip_and_wrong_key() {
        let payload = json!({ "kind": "hello", "name": "书房" });
        let sealed = seal("k1", &payload).unwrap();
        assert!(sealed.starts_with(PREFIX));
        assert!(!sealed.contains("hello"));
        assert_eq!(open::<Value>("k1", &sealed), Some(payload));
        assert_eq!(open::<Value>("k2", &sealed), None);
        assert_eq!(open::<Value>("k1", "fsx1.garbage"), None);
        assert_eq!(open::<Value>("k1", "plain"), None);
        assert_ne!(seal("k1", &json!(1)).unwrap(), seal("k1", &json!(1)).unwrap());
    }
}
