use crate::frame::{quote, Id};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

#[derive(Debug)]
pub struct Request {
    pub id: Id,
    pub method: String,
    pub deadline: Instant,
    pub ms: u64,
}

impl Request {
    pub fn synthetic(&self) -> String {
        let result = if self.method == "_x.ai/hooks/run" {
            format!(
                r#"{{"decision":"deny","reason":"pi-grok-leash: no answer in {} ms"}}"#,
                self.ms
            )
        } else {
            r#"{"outcome":{"outcome":"cancelled"}}"#.to_owned()
        };
        format!(
            r#"{{"jsonrpc":"2.0","id":{},"result":{result}}}"#,
            self.id.raw
        )
    }
    pub fn event_fields(&self) -> String {
        format!(
            r#""id":{},"method":{},"ms":{}"#,
            self.id.raw,
            quote(&self.method),
            self.ms
        )
    }
}

#[derive(Default)]
pub struct Tracker {
    pending: HashMap<String, Request>,
    answered: HashSet<String>,
}

impl Tracker {
    /// False means the outstanding-request limit was exceeded.
    pub fn track(&mut self, id: Id, method: String, ms: u64, now: Instant) -> bool {
        if self.pending.len() == 64 && !self.pending.contains_key(&id.key) {
            return false;
        }
        self.answered.remove(&id.key);
        self.pending.insert(
            id.key.clone(),
            Request {
                id,
                method,
                deadline: now + Duration::from_millis(ms),
                ms,
            },
        );
        true
    }
    pub fn extend(&mut self, id: &Id, ms: u64, now: Instant) {
        if let Some(request) = self.pending.get_mut(&id.key) {
            // Expiration is final even if the timer has not processed it yet.
            if now < request.deadline {
                request.deadline = now + Duration::from_millis(ms);
                request.ms = ms;
            }
        }
    }
    pub fn expire(&mut self, now: Instant) -> Vec<Request> {
        let mut expired = Vec::new();
        let keys: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, r)| now >= r.deadline)
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            let request = self.pending.remove(&key).unwrap();
            self.answered.insert(key);
            expired.push(request);
        }
        expired.sort_by_key(|r| r.deadline);
        expired
    }
    /// Call expire(now) first. True means this is a late reply and must be dropped.
    pub fn reply(&mut self, id: &Id) -> bool {
        self.pending.remove(&id.key);
        self.answered.contains(&id.key)
    }
}

pub struct Heartbeat {
    last: Instant,
    last_tick: Instant,
    stall: Duration,
}
impl Heartbeat {
    pub fn new(now: Instant, stall_ms: u64) -> Self {
        Self {
            last: now,
            last_tick: now,
            stall: Duration::from_millis(stall_ms),
        }
    }
    pub fn beat(&mut self, now: Instant) {
        self.last = now;
    }
    /// A large scheduling gap rebases the watchdog before checking for a stall.
    /// Ordinary missing beats still trip at stall-ms, not at ten times that value.
    pub fn stalled(&mut self, now: Instant) -> bool {
        let suspended = now.duration_since(self.last_tick) > self.stall.saturating_mul(10);
        self.last_tick = now;
        if suspended {
            self.last = now;
        }
        now.duration_since(self.last) >= self.stall
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id(n: u32) -> Id {
        Id {
            raw: n.to_string(),
            key: format!("n:{n}"),
        }
    }
    #[test]
    fn deadlines_and_late_replies() {
        let now = Instant::now();
        let mut tracker = Tracker::default();
        assert!(tracker.track(id(1), "_x.ai/hooks/run".into(), 25, now));
        assert!(tracker.expire(now + Duration::from_millis(24)).is_empty());
        let expired = tracker.expire(now + Duration::from_millis(25));
        assert_eq!(expired.len(), 1);
        assert_eq!(
            expired[0].synthetic(),
            r#"{"jsonrpc":"2.0","id":1,"result":{"decision":"deny","reason":"pi-grok-leash: no answer in 25 ms"}}"#
        );
        assert!(tracker.reply(&id(1)));
        assert!(tracker.reply(&id(1)));
        assert!(tracker.expire(now + Duration::from_secs(1)).is_empty());
    }
    #[test]
    fn timely_reply_clears_request() {
        let now = Instant::now();
        let mut tracker = Tracker::default();
        tracker.track(id(1), "_x.ai/hooks/run".into(), 25, now);
        assert!(!tracker.reply(&id(1)));
        assert!(tracker.expire(now + Duration::from_secs(1)).is_empty());
        assert!(!tracker.reply(&id(99)));
    }
    #[test]
    fn extension_moves_deadline_and_expired_extensions_are_ignored() {
        let now = Instant::now();
        let mut tracker = Tracker::default();
        tracker.track(id(1), "session/request_permission".into(), 25, now);
        tracker.extend(&id(1), 100, now + Duration::from_millis(20));
        assert!(tracker.expire(now + Duration::from_millis(119)).is_empty());
        tracker.extend(&id(1), 999, now + Duration::from_millis(120));
        let expired = tracker.expire(now + Duration::from_millis(120));
        assert_eq!(expired[0].ms, 100);
        assert_eq!(
            expired[0].synthetic(),
            r#"{"jsonrpc":"2.0","id":1,"result":{"outcome":{"outcome":"cancelled"}}}"#
        );
        tracker.extend(&id(1), 999, now + Duration::from_millis(121));
        assert!(tracker.pending.is_empty());
    }
    #[test]
    fn question_and_string_id() {
        let now = Instant::now();
        let mut tracker = Tracker::default();
        let id = Id {
            raw: r#""ab\"c""#.into(),
            key: "s:ab\"c".into(),
        };
        tracker.track(id, "_x.ai/ask_user_question".into(), 1, now);
        let expired = tracker.expire(now + Duration::from_millis(1));
        assert_eq!(
            expired[0].synthetic(),
            r#"{"jsonrpc":"2.0","id":"ab\"c","result":{"outcome":{"outcome":"cancelled"}}}"#
        );
    }
    #[test]
    fn limit_is_64_outstanding() {
        let now = Instant::now();
        let mut tracker = Tracker::default();
        for n in 0..64 {
            assert!(tracker.track(id(n), "_x.ai/hooks/run".into(), 25, now));
        }
        assert!(!tracker.track(id(64), "_x.ai/hooks/run".into(), 25, now));
        assert!(!tracker.reply(&id(1)));
        assert!(tracker.track(id(64), "_x.ai/hooks/run".into(), 25, now));
    }
    #[test]
    fn heartbeat_and_suspend_rebaseline() {
        let now = Instant::now();
        let mut heartbeat = Heartbeat::new(now, 100);
        assert!(!heartbeat.stalled(now + Duration::from_millis(99)));
        heartbeat.beat(now + Duration::from_millis(99));
        assert!(!heartbeat.stalled(now + Duration::from_millis(198)));
        assert!(heartbeat.stalled(now + Duration::from_millis(199)));
        assert!(!heartbeat.stalled(now + Duration::from_secs(20)));
        heartbeat.beat(now + Duration::from_secs(20));
        assert!(!heartbeat.stalled(now + Duration::from_millis(20099)));
        assert!(heartbeat.stalled(now + Duration::from_millis(20100)));
    }
}
