use super::parser::Expr;
use super::{date_str, dur_str, format_date, natural, num_str, parse_date, parse_duration, relative, shift, wiki_re, FileRec, Files, V};
use chrono::{Datelike, Duration, NaiveDateTime, NaiveTime, Timelike};
use regex::Regex;
use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};

pub(super) struct Ctx<'a, 'b> {
    files: &'b Files<'a>,
    file: usize,
    this: Option<usize>,
    formulas: &'b BTreeMap<String, Result<Expr, String>>,
    cache: RefCell<HashMap<String, V>>,
    depth: std::cell::Cell<u32>,
    now: NaiveDateTime,
    /// `value` / `index` inside list.filter()/map().
    locals: RefCell<Vec<(String, V)>>,
}

type R = Result<V, String>;

fn want_num(v: &V) -> Option<f64> {
    match v {
        V::Num(n) => Some(*n),
        V::Bool(b) => Some(*b as u8 as f64),
        V::Str(s) => s.trim().parse().ok(),
        V::Dur(ms) => Some(*ms as f64),
        V::Date(d, _) => Some(d.and_utc().timestamp_millis() as f64),
        _ => None,
    }
}

impl<'a, 'b> Ctx<'a, 'b> {
    pub(super) fn new(
        files: &'b Files<'a>,
        file: usize,
        this: Option<usize>,
        formulas: &'b BTreeMap<String, Result<Expr, String>>,
        now: NaiveDateTime,
    ) -> Self {
        Self {
            files,
            file,
            this,
            formulas,
            now,
            cache: RefCell::new(HashMap::new()),
            depth: std::cell::Cell::new(0),
            locals: RefCell::new(vec![]),
        }
    }

    pub(super) fn file_path(&self, index: usize) -> &str {
        &self.files.list[index].path
    }

    pub(super) fn current_file(&self) -> &FileRec {
        &self.files.list[self.file]
    }

    pub(super) fn to_string(&self, v: &V) -> String {
        match v {
            V::Null => String::new(),
            V::Bool(b) => b.to_string(),
            V::Num(n) => num_str(*n),
            V::Str(s) => s.clone(),
            V::Date(d, t) => date_str(d, *t),
            V::Dur(ms) => dur_str(*ms),
            V::List(l) => l.iter().map(|x| self.to_string(x)).collect::<Vec<_>>().join(", "),
            V::Link { path, target, display } => display.clone().unwrap_or_else(|| path.as_deref().map(crate::links::stem_of).unwrap_or_else(|| target.clone())),
            V::File(i) => crate::links::stem_of(&self.files.list[*i].path),
            V::Obj(o) => serde_json::to_string(&o.iter().map(|(k, v)| (k.clone(), self.to_string(v))).collect::<BTreeMap<_, _>>()).unwrap_or_default(),
            V::Regex(r) => format!("/{}/", r.as_str()),
        }
    }

    fn prop(&self, file: usize, name: &str) -> V {
        let f = &self.files.list[file];
        f.props.get(name).cloned().or_else(|| f.props.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone())).unwrap_or(V::Null)
    }

    fn formula(&self, name: &str) -> R {
        if let Some(v) = self.cache.borrow().get(name) {
            return Ok(v.clone());
        }
        let e = match self.formulas.get(name) {
            Some(Ok(e)) => e,
            Some(Err(err)) => return Err(format!("formula {name}: {err}")),
            None => return Ok(V::Null),
        };
        if self.depth.get() > 32 {
            return Err(format!("formula {name} refers to itself"));
        }
        self.depth.set(self.depth.get() + 1);
        let v = self.eval(e);
        self.depth.set(self.depth.get() - 1);
        let v = v?;
        self.cache.borrow_mut().insert(name.to_string(), v.clone());
        Ok(v)
    }

    /// The value of a column id: `file.name`, `note.status`, `status`, `formula.x`.
    pub(super) fn column(&self, id: &str) -> R {
        if let Some(n) = id.strip_prefix("formula.") {
            return self.formula(n);
        }
        if let Some(n) = id.strip_prefix("note.") {
            return Ok(self.prop(self.file, n));
        }
        if let Some(n) = id.strip_prefix("file.") {
            return self.file_member(self.file, n);
        }
        Ok(self.prop(self.file, id))
    }

    fn file_member(&self, i: usize, name: &str) -> R {
        let f = &self.files.list[i];
        let name_of = |p: &str| p.rsplit('/').next().unwrap_or(p).to_string();
        Ok(match name {
            "name" => V::Str(name_of(&f.path)),
            "basename" => V::Str(crate::links::stem_of(&f.path)),
            "path" => V::Str(f.path.clone()),
            "folder" => V::Str(f.path.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default()),
            "ext" => V::Str(name_of(&f.path).rsplit_once('.').map(|(_, e)| e.to_string()).unwrap_or_default()),
            "size" => V::Num(f.size as f64),
            "ctime" => f.ctime.map(|d| V::Date(d, true)).unwrap_or(V::Null),
            "mtime" => f.mtime.map(|d| V::Date(d, true)).unwrap_or(V::Null),
            "tags" => V::List(f.tags.iter().map(|t| V::Str(format!("#{t}"))).collect()),
            "links" | "embeds" => {
                let embeds = name == "embeds";
                let mut seen = std::collections::HashSet::new();
                V::List(
                    self.files
                        .links_of(i)
                        .iter()
                        .filter(|(_, _, e)| *e == embeds || !embeds)
                        .filter(|(p, t, _)| seen.insert(p.clone().unwrap_or_else(|| t.clone())))
                        .map(|(p, t, _)| V::Link { path: p.clone(), target: t.clone(), display: None })
                        .collect(),
                )
            }
            "backlinks" => V::List(self.files.backlinks_of(i).into_iter().map(|j| V::Link { path: Some(self.files.list[j].path.clone()), target: self.files.list[j].path.clone(), display: None }).collect()),
            "properties" => V::Obj(f.props.clone()),
            "file" => V::File(i),
            _ => return Err(format!("file.{name} is unknown")),
        })
    }

    fn lookup(&self, name: &str) -> R {
        if let Some((_, v)) = self.locals.borrow().iter().rev().find(|(n, _)| n == name) {
            return Ok(v.clone());
        }
        Ok(match name {
            "file" => V::File(self.file),
            "note" => V::Obj(self.current_file().props.clone()),
            "this" => match self.this {
                Some(t) => V::Obj(BTreeMap::from([("\u{0}this".to_string(), V::File(t))])),
                None => V::Null,
            },
            _ => self.prop(self.file, name),
        })
    }

    pub(super) fn eval(&self, e: &Expr) -> R {
        match e {
            Expr::Lit(v) => Ok(v.clone()),
            Expr::Ident(n) => self.lookup(n),
            Expr::Member(obj, name) => {
                // formula.x, note.x, this.x
                if let Expr::Ident(base) = &**obj {
                    if base == "formula" && self.locals.borrow().iter().all(|(n, _)| n != "formula") {
                        return self.formula(name);
                    }
                    if base == "note" {
                        return Ok(self.prop(self.file, name));
                    }
                    if base == "this" {
                        let Some(t) = self.this else { return Ok(V::Null) };
                        return Ok(match name.as_str() {
                            "file" => V::File(t),
                            "note" => V::Obj(self.files.list[t].props.clone()),
                            _ => self.prop(t, name),
                        });
                    }
                }
                let v = self.eval(obj)?;
                self.member(&v, name)
            }
            Expr::Index(obj, idx) => {
                let v = self.eval(obj)?;
                let i = self.eval(idx)?;
                Ok(match (&v, &i) {
                    (V::List(l), _) => {
                        let n = want_num(&i).unwrap_or(0.0) as i64;
                        let n = if n < 0 { l.len() as i64 + n } else { n };
                        l.get(n as usize).cloned().unwrap_or(V::Null)
                    }
                    (V::Obj(o), _) => o.get(&self.to_string(&i)).cloned().unwrap_or(V::Null),
                    (V::Str(s), _) => s.chars().nth(want_num(&i).unwrap_or(0.0) as usize).map(|c| V::Str(c.to_string())).unwrap_or(V::Null),
                    (V::File(f), _) => self.prop(*f, &self.to_string(&i)),
                    _ => V::Null,
                })
            }
            Expr::Call(callee, args) => match &**callee {
                Expr::Ident(name) => self.global(name, args),
                Expr::Member(obj, name) => {
                    if let Expr::Ident(base) = &**obj {
                        if base == "this" && self.this.is_none() {
                            return Ok(V::Null);
                        }
                    }
                    let v = self.eval(obj)?;
                    self.method(&v, name, args)
                }
                _ => Err("this can't be called".into()),
            },
            Expr::Unary(op, x) => {
                let v = self.eval(x)?;
                Ok(match *op {
                    "!" => V::Bool(!v.truthy()),
                    _ => match v {
                        V::Dur(d) => V::Dur(-d),
                        v => V::Num(-want_num(&v).unwrap_or(f64::NAN)),
                    },
                })
            }
            Expr::Cond(c, a, b) => {
                if self.eval(c)?.truthy() { self.eval(a) } else { self.eval(b) }
            }
            Expr::Bin(op, a, b) => {
                if *op == "&&" {
                    let l = self.eval(a)?;
                    return if l.truthy() { Ok(V::Bool(self.eval(b)?.truthy())) } else { Ok(V::Bool(false)) };
                }
                if *op == "||" {
                    let l = self.eval(a)?;
                    return if l.truthy() { Ok(l) } else { self.eval(b) };
                }
                let l = self.eval(a)?;
                let r = self.eval(b)?;
                self.binary(op, l, r)
            }
        }
    }

    fn binary(&self, op: &str, l: V, r: V) -> R {
        match op {
            "==" => return Ok(V::Bool(self.equal(&l, &r))),
            "!=" => return Ok(V::Bool(!self.equal(&l, &r))),
            "<" | "<=" | ">" | ">=" => {
                if matches!(l, V::Null) || matches!(r, V::Null) {
                    return Ok(V::Bool(false));
                }
                let o = self.compare(&l, &r);
                return Ok(V::Bool(match op {
                    "<" => o == Ordering::Less,
                    "<=" => o != Ordering::Greater,
                    ">" => o == Ordering::Greater,
                    _ => o != Ordering::Less,
                }));
            }
            _ => {}
        }
        Ok(match (op, &l, &r) {
            ("+", V::Date(d, t), V::Str(s)) => shift(*d, s, 1).map(|x| V::Date(x, *t)).unwrap_or(V::Null),
            ("-", V::Date(d, t), V::Str(s)) if parse_date(s).is_none() => shift(*d, s, -1).map(|x| V::Date(x, *t)).unwrap_or(V::Null),
            ("+", V::Date(d, t), V::Dur(ms)) => V::Date(*d + Duration::milliseconds(*ms), *t),
            ("-", V::Date(d, t), V::Dur(ms)) => V::Date(*d - Duration::milliseconds(*ms), *t),
            ("-", V::Date(a, _), V::Date(b, _)) => V::Dur((*a - *b).num_milliseconds()),
            ("-", V::Date(a, _), V::Str(s)) => parse_date(s).map(|(b, _)| V::Dur((*a - b).num_milliseconds())).unwrap_or(V::Null),
            ("+", V::Dur(a), V::Dur(b)) => V::Dur(a + b),
            ("-", V::Dur(a), V::Dur(b)) => V::Dur(a - b),
            ("+", V::List(a), V::List(b)) => V::List(a.iter().chain(b).cloned().collect()),
            ("+", V::List(a), x) => V::List(a.iter().cloned().chain([x.clone()]).collect()),
            ("+", V::Str(_), _) | ("+", _, V::Str(_)) if want_num(&l).is_none() || want_num(&r).is_none() || matches!((&l, &r), (V::Str(_), V::Str(_))) => {
                V::Str(format!("{}{}", self.to_string(&l), self.to_string(&r)))
            }
            _ => {
                let (Some(a), Some(b)) = (want_num(&l), want_num(&r)) else { return Ok(V::Null) };
                if matches!(l, V::Null) || matches!(r, V::Null) {
                    return Ok(V::Null);
                }
                V::Num(match op {
                    "+" => a + b,
                    "-" => a - b,
                    "*" => a * b,
                    "/" => a / b,
                    _ => a % b,
                })
            }
        })
    }

    fn path_of(&self, v: &V) -> Option<String> {
        match v {
            V::File(i) => Some(self.files.list[*i].path.clone()),
            V::Link { path, .. } => path.clone(),
            V::Str(s) => {
                if let Some(c) = wiki_re().captures(s.trim()) {
                    return self.files.resolver.resolve(&self.current_file().path, &c[1]).map(|(p, _)| p);
                }
                self.files.resolver.resolve(&self.current_file().path, s).map(|(p, _)| p)
            }
            _ => None,
        }
    }

    fn equal(&self, a: &V, b: &V) -> bool {
        match (a, b) {
            (V::Null, x) | (x, V::Null) => x.is_empty(),
            (V::Num(x), V::Num(y)) => x == y,
            (V::Bool(x), V::Bool(y)) => x == y,
            (V::Str(x), V::Str(y)) => x == y,
            (V::Date(x, _), V::Date(y, _)) => x == y,
            (V::Date(x, t), V::Str(s)) | (V::Str(s), V::Date(x, t)) => parse_date(s).is_some_and(|(y, ty)| if *t && ty { *x == y } else { x.date() == y.date() }),
            (V::List(x), V::List(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| self.equal(a, b)),
            (V::Link { .. } | V::File(_), V::Link { .. } | V::File(_)) => self.path_of(a).is_some() && self.path_of(a) == self.path_of(b),
            (V::Link { .. } | V::File(_), V::Str(s)) | (V::Str(s), V::Link { .. } | V::File(_)) => {
                let l = if matches!(a, V::Str(_)) { b } else { a };
                self.path_of(l).is_some_and(|p| Some(p.clone()) == self.path_of(&V::Str(s.clone())) || crate::links::stem_of(&p) == *s)
            }
            (V::Num(n), V::Str(s)) | (V::Str(s), V::Num(n)) => s.trim().parse::<f64>().is_ok_and(|x| x == *n),
            (V::Bool(x), V::Str(s)) | (V::Str(s), V::Bool(x)) => s.trim().eq_ignore_ascii_case(if *x { "true" } else { "false" }),
            (V::Dur(x), V::Dur(y)) => x == y,
            _ => false,
        }
    }

    /// Sort order: numbers, dates and durations by value, text naturally
    /// (case-insensitive, numbers inside text by value); empty values last.
    pub(super) fn compare(&self, a: &V, b: &V) -> Ordering {
        match (a, b) {
            (V::Null, V::Null) => Ordering::Equal,
            (V::Null, _) => Ordering::Greater,
            (_, V::Null) => Ordering::Less,
            (V::Num(x), V::Num(y)) => x.partial_cmp(y).unwrap_or(Ordering::Equal),
            (V::Date(x, _), V::Date(y, _)) => x.cmp(y),
            (V::Date(x, _), V::Str(s)) => parse_date(s).map(|(y, _)| x.cmp(&y)).unwrap_or(Ordering::Less),
            (V::Str(s), V::Date(y, _)) => parse_date(s).map(|(x, _)| x.cmp(y)).unwrap_or(Ordering::Greater),
            (V::Dur(x), V::Dur(y)) => x.cmp(y),
            (V::Bool(x), V::Bool(y)) => x.cmp(y),
            (V::Num(_), V::Str(_)) | (V::Str(_), V::Num(_)) | (V::Bool(_), _) | (_, V::Bool(_)) if want_num(a).is_some() && want_num(b).is_some() => {
                want_num(a).unwrap().partial_cmp(&want_num(b).unwrap()).unwrap_or(Ordering::Equal)
            }
            (V::List(x), V::List(y)) => {
                for (p, q) in x.iter().zip(y) {
                    let o = self.compare(p, q);
                    if o != Ordering::Equal {
                        return o;
                    }
                }
                x.len().cmp(&y.len())
            }
            _ => natural(&self.to_string(a), &self.to_string(b)),
        }
    }

    fn arg(&self, args: &[Expr], i: usize) -> R {
        args.get(i).map(|e| self.eval(e)).unwrap_or(Ok(V::Null))
    }

    fn global(&self, name: &str, args: &[Expr]) -> R {
        let a = |i| self.arg(args, i);
        Ok(match name {
            "if" => {
                if a(0)?.truthy() { a(1)? } else { a(2)? }
            }
            "now" => V::Date(self.now, true),
            "today" => V::Date(self.now.date().and_time(NaiveTime::MIN), false),
            "date" => match a(0)? {
                V::Date(d, t) => V::Date(d, t),
                V::Str(s) => parse_date(&s).map(|(d, t)| V::Date(d, t)).unwrap_or(V::Null),
                V::Num(n) => chrono::DateTime::from_timestamp_millis(n as i64).map(|d| V::Date(d.naive_utc(), true)).unwrap_or(V::Null),
                _ => V::Null,
            },
            "duration" => match a(0)? {
                V::Str(s) => parse_duration(&s).map(V::Dur).unwrap_or(V::Null),
                V::Num(n) => V::Dur(n as i64),
                v => v,
            },
            "number" => match a(0)? {
                V::Date(d, _) => V::Num(d.and_utc().timestamp_millis() as f64),
                v => want_num(&v).map(V::Num).unwrap_or(V::Null),
            },
            "string" => V::Str(self.to_string(&a(0)?)),
            "list" => {
                if args.len() == 1 {
                    match a(0)? {
                        V::List(l) => V::List(l),
                        V::Null => V::List(vec![]),
                        v => V::List(vec![v]),
                    }
                } else {
                    V::List(args.iter().map(|e| self.eval(e)).collect::<Result<_, _>>()?)
                }
            }
            "link" => {
                let target = a(0)?;
                let display = match a(1)? {
                    V::Null => None,
                    d => Some(self.to_string(&d)),
                };
                match target {
                    V::File(i) => V::Link { path: Some(self.files.list[i].path.clone()), target: self.files.list[i].path.clone(), display },
                    V::Link { path, target, .. } => V::Link { path, target, display },
                    t => {
                        let s = self.to_string(&t);
                        let s = wiki_re().captures(s.trim()).map(|c| c[1].to_string()).unwrap_or(s);
                        if s.contains("://") {
                            V::Link { path: None, target: s, display }
                        } else {
                            self.files.link(&self.current_file().path, &s, display)
                        }
                    }
                }
            }
            "file" => {
                let v = a(0)?;
                self.path_of(&v).and_then(|p| self.files.find(&p)).map(V::File).unwrap_or(V::Null)
            }
            "image" | "icon" | "html" | "escapeHTML" => a(0)?,
            "min" | "max" => {
                let mut vals: Vec<V> = vec![];
                for e in args {
                    match self.eval(e)? {
                        V::List(l) => vals.extend(l),
                        v => vals.push(v),
                    }
                }
                let vals: Vec<V> = vals.into_iter().filter(|v| !matches!(v, V::Null)).collect();
                let pick = vals.into_iter().reduce(|x, y| {
                    let o = self.compare(&x, &y);
                    if (name == "min") == (o == Ordering::Greater) { y } else { x }
                });
                pick.unwrap_or(V::Null)
            }
            _ => return Err(format!("unknown function {name}()")),
        })
    }

    fn member(&self, v: &V, name: &str) -> R {
        Ok(match (v, name) {
            (V::Obj(o), _) if o.contains_key("\u{0}this") => {
                let V::File(t) = o["\u{0}this"] else { return Ok(V::Null) };
                match name {
                    "file" => V::File(t),
                    "note" => V::Obj(self.files.list[t].props.clone()),
                    _ => self.prop(t, name),
                }
            }
            (V::File(i), _) => match self.file_member(*i, name) {
                Ok(v) => v,
                Err(_) => self.prop(*i, name),
            },
            (V::Link { path, .. }, _) if name != "length" => match path.as_ref().and_then(|p| self.files.find(p)) {
                Some(i) => self.file_member(i, name).unwrap_or_else(|_| self.prop(i, name)),
                None => V::Null,
            },
            (V::Str(s), "length") => V::Num(s.chars().count() as f64),
            (V::List(l), "length") => V::Num(l.len() as f64),
            (V::Date(d, _), "year") => V::Num(d.year() as f64),
            (V::Date(d, _), "month") => V::Num(d.month() as f64),
            (V::Date(d, _), "day") => V::Num(d.day() as f64),
            (V::Date(d, _), "hour") => V::Num(d.hour() as f64),
            (V::Date(d, _), "minute") => V::Num(d.minute() as f64),
            (V::Date(d, _), "second") => V::Num(d.second() as f64),
            (V::Date(d, _), "millisecond") => V::Num((d.and_utc().timestamp_subsec_millis()) as f64),
            (V::Dur(ms), "days") => V::Num(*ms as f64 / 8.64e7),
            (V::Dur(ms), "hours") => V::Num(*ms as f64 / 3.6e6),
            (V::Dur(ms), "minutes") => V::Num(*ms as f64 / 6e4),
            (V::Dur(ms), "seconds") => V::Num(*ms as f64 / 1e3),
            (V::Dur(ms), "milliseconds") => V::Num(*ms as f64),
            (V::Obj(o), _) => o.get(name).cloned().unwrap_or(V::Null),
            _ => V::Null,
        })
    }

    fn method(&self, v: &V, name: &str, args: &[Expr]) -> R {
        let a = |i| self.arg(args, i);
        let s_arg = |i| -> Result<String, String> { Ok(self.to_string(&self.arg(args, i)?)) };
        // Any type.
        match name {
            "isEmpty" => return Ok(V::Bool(v.is_empty())),
            "isTruthy" => return Ok(V::Bool(v.truthy())),
            "isType" => return Ok(V::Bool(v.type_name() == s_arg(0)?.to_lowercase())),
            "toString" => return Ok(V::Str(self.to_string(v))),
            _ => {}
        }
        Ok(match v {
            V::File(i) => {
                let f = &self.files.list[*i];
                match name {
                    "hasTag" => {
                        let mut want = vec![];
                        for e in args {
                            match self.eval(e)? {
                                V::List(l) => want.extend(l.iter().map(|x| self.to_string(x))),
                                x => want.push(self.to_string(&x)),
                            }
                        }
                        V::Bool(want.iter().any(|w| {
                            let w = w.trim_start_matches('#').to_lowercase();
                            f.tags.iter().any(|t| {
                                let t = t.to_lowercase();
                                t == w || t.starts_with(&format!("{w}/"))
                            })
                        }))
                    }
                    "inFolder" => {
                        let d = s_arg(0)?.trim_matches('/').to_string();
                        V::Bool(d.is_empty() || f.path.starts_with(&format!("{d}/")))
                    }
                    "hasProperty" => {
                        let p = s_arg(0)?;
                        V::Bool(f.props.keys().any(|k| k.eq_ignore_ascii_case(&p)))
                    }
                    "hasLink" | "linksTo" => {
                        let to = self.path_of(&a(0)?);
                        V::Bool(to.is_some_and(|to| self.files.links_of(*i).iter().any(|(p, _, _)| p.as_deref() == Some(&to))))
                    }
                    "asLink" => V::Link {
                        path: Some(f.path.clone()),
                        target: f.path.clone(),
                        display: match a(0)? {
                            V::Null => None,
                            d => Some(self.to_string(&d)),
                        },
                    },
                    _ => return Err(format!("file.{name}() is unknown")),
                }
            }
            V::Link { path, target, display } => match name {
                "asFile" => path.as_ref().and_then(|p| self.files.find(p)).map(V::File).unwrap_or(V::Null),
                "linksTo" => {
                    let to = self.path_of(&a(0)?);
                    let from = path.as_ref().and_then(|p| self.files.find(p));
                    V::Bool(matches!((to, from), (Some(to), Some(i)) if self.files.links_of(i).iter().any(|(p, _, _)| p.as_deref() == Some(&to))))
                }
                _ => {
                    let s = display.clone().unwrap_or_else(|| path.as_deref().map(crate::links::stem_of).unwrap_or_else(|| target.clone()));
                    return self.method(&V::Str(s), name, args);
                }
            },
            V::Str(s) => match name {
                "contains" => V::Bool(s.contains(&s_arg(0)?)),
                "containsAll" => V::Bool(args.iter().all(|e| self.eval(e).map(|x| s.contains(&self.to_string(&x))).unwrap_or(false))),
                "containsAny" => V::Bool(args.iter().any(|e| self.eval(e).map(|x| s.contains(&self.to_string(&x))).unwrap_or(false))),
                "startsWith" => V::Bool(s.starts_with(&s_arg(0)?)),
                "endsWith" => V::Bool(s.ends_with(&s_arg(0)?)),
                "lower" => V::Str(s.to_lowercase()),
                "upper" => V::Str(s.to_uppercase()),
                "title" => V::Str(s.split(' ').map(|w| {
                    let mut c = w.chars();
                    c.next().map(|f| f.to_uppercase().collect::<String>() + &c.as_str().to_lowercase()).unwrap_or_default()
                }).collect::<Vec<_>>().join(" ")),
                "trim" => V::Str(s.trim().to_string()),
                "reverse" => V::Str(s.chars().rev().collect()),
                "repeat" => V::Str(s.repeat(want_num(&a(0)?).unwrap_or(0.0).max(0.0) as usize)),
                "slice" => {
                    let cs: Vec<char> = s.chars().collect();
                    let (st, en) = slice_bounds(cs.len(), want_num(&a(0)?), want_num(&a(1)?));
                    V::Str(cs[st..en].iter().collect())
                }
                "split" => {
                    let sep = a(0)?;
                    let parts: Vec<V> = match &sep {
                        V::Regex(r) => r.split(s).map(|x| V::Str(x.to_string())).collect(),
                        _ => {
                            let sep = self.to_string(&sep);
                            if sep.is_empty() { s.chars().map(|c| V::Str(c.to_string())).collect() } else { s.split(sep.as_str()).map(|x| V::Str(x.to_string())).collect() }
                        }
                    };
                    V::List(parts)
                }
                "replace" | "replaceAll" => {
                    let with = s_arg(1)?;
                    match a(0)? {
                        V::Regex(r) => V::Str(r.replace_all(s, with.as_str()).into_owned()),
                        p => {
                            let p = self.to_string(&p);
                            V::Str(if name == "replace" { s.replacen(&p, &with, 1) } else { s.replace(&p, &with) })
                        }
                    }
                }
                "matches" => match a(0)? {
                    V::Regex(r) => V::Bool(r.is_match(s)),
                    p => V::Bool(Regex::new(&self.to_string(&p)).map(|r| r.is_match(s)).unwrap_or(false)),
                },
                "date" | "format" | "relative" | "time" => match parse_date(s) {
                    Some((d, t)) => return self.method(&V::Date(d, t), name, args),
                    None => V::Null,
                },
                "toFixed" | "round" | "floor" | "ceil" | "abs" => match s.trim().parse::<f64>() {
                    Ok(n) => return self.method(&V::Num(n), name, args),
                    Err(_) => V::Null,
                },
                _ => return Err(format!("text has no .{name}()")),
            },
            V::Num(n) => match name {
                "abs" => V::Num(n.abs()),
                "ceil" => V::Num(n.ceil()),
                "floor" => V::Num(n.floor()),
                "round" => {
                    let d = want_num(&a(0)?).unwrap_or(0.0) as i32;
                    let f = 10f64.powi(d);
                    V::Num((n * f).round() / f)
                }
                "toFixed" => V::Str(format!("{:.*}", want_num(&a(0)?).unwrap_or(0.0).max(0.0) as usize, n)),
                _ => return Err(format!("a number has no .{name}()")),
            },
            V::Date(d, t) => match name {
                "format" => V::Str(format_date(d, &s_arg(0)?)),
                "date" => V::Date(d.date().and_time(NaiveTime::MIN), false),
                "time" => V::Str(d.format("%H:%M:%S").to_string()),
                "relative" => V::Str(relative(d, &self.now)),
                _ => {
                    let _ = t;
                    return Err(format!("a date has no .{name}()"));
                }
            },
            V::Dur(ms) => match name {
                "format" => V::Str(dur_str(*ms)),
                _ => return Err(format!("a duration has no .{name}()")),
            },
            V::List(l) => match name {
                "contains" => {
                    let x = a(0)?;
                    V::Bool(l.iter().any(|y| self.equal(y, &x)))
                }
                "containsAll" | "containsAny" => {
                    let mut want = vec![];
                    for e in args {
                        match self.eval(e)? {
                            V::List(x) => want.extend(x),
                            x => want.push(x),
                        }
                    }
                    let has = |x: &V| l.iter().any(|y| self.equal(y, x));
                    V::Bool(if name == "containsAll" { want.iter().all(has) } else { want.iter().any(has) })
                }
                "join" => V::Str(l.iter().map(|x| self.to_string(x)).collect::<Vec<_>>().join(&match a(0)? {
                    V::Null => ", ".to_string(),
                    s => self.to_string(&s),
                })),
                "reverse" => V::List(l.iter().rev().cloned().collect()),
                "sort" => {
                    let mut v = l.clone();
                    v.sort_by(|x, y| self.compare(x, y));
                    V::List(v)
                }
                "unique" => {
                    let mut out: Vec<V> = vec![];
                    for x in l {
                        if !out.iter().any(|y| self.equal(x, y)) {
                            out.push(x.clone());
                        }
                    }
                    V::List(out)
                }
                "flat" => V::List(l.iter().flat_map(|x| match x {
                    V::List(i) => i.clone(),
                    x => vec![x.clone()],
                }).collect()),
                "slice" => {
                    let (st, en) = slice_bounds(l.len(), want_num(&a(0)?), want_num(&a(1)?));
                    V::List(l[st..en].to_vec())
                }
                "filter" | "map" => {
                    let Some(body) = args.first() else { return Ok(v.clone()) };
                    let mut out = vec![];
                    for (i, x) in l.iter().enumerate() {
                        self.locals.borrow_mut().push(("value".into(), x.clone()));
                        self.locals.borrow_mut().push(("index".into(), V::Num(i as f64)));
                        let r = self.eval(body);
                        {
                            let mut l = self.locals.borrow_mut();
                            let n = l.len() - 2;
                            l.truncate(n);
                        }
                        let r = r?;
                        if name == "map" {
                            out.push(r);
                        } else if r.truthy() {
                            out.push(x.clone());
                        }
                    }
                    V::List(out)
                }
                _ => return Err(format!("a list has no .{name}()")),
            },
            V::Obj(o) => match name {
                "keys" => V::List(o.keys().filter(|k| !k.starts_with('\u{0}')).map(|k| V::Str(k.clone())).collect()),
                "values" => V::List(o.values().cloned().collect()),
                _ => return Err(format!("an object has no .{name}()")),
            },
            V::Regex(r) => match name {
                "matches" => V::Bool(r.is_match(&s_arg(0)?)),
                _ => return Err(format!("a regular expression has no .{name}()")),
            },
            V::Null => V::Null,
            V::Bool(_) => return Err(format!("a boolean has no .{name}()")),
        })
    }
}

fn slice_bounds(len: usize, a: Option<f64>, b: Option<f64>) -> (usize, usize) {
    let norm = |x: f64| -> usize {
        let x = x as i64;
        if x < 0 { (len as i64 + x).max(0) as usize } else { (x as usize).min(len) }
    };
    let s = a.map(norm).unwrap_or(0);
    let e = b.map(norm).unwrap_or(len);
    (s.min(e), e.max(s))
}
