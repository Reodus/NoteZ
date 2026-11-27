use super::V;
use regex::Regex;

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Num(f64),
    Str(String),
    Ident(String),
    Op(&'static str),
    Regex(String, String),
}

fn lex(src: &str) -> Result<Vec<Tok>, String> {
    let cs: Vec<char> = src.chars().collect();
    let mut out = vec![];
    let mut i = 0;
    const OPS: [&str; 22] = ["==", "!=", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "<", ">", "!", "(", ")", "[", "]", ",", ".", "?", ":"];
    while i < cs.len() {
        let c = cs[i];
        if c.is_whitespace() {
            i += 1;
        } else if c.is_ascii_digit() || (c == '.' && cs.get(i + 1).is_some_and(|d| d.is_ascii_digit())) {
            let start = i;
            let mut dot = false;
            while i < cs.len() && (cs[i].is_ascii_digit() || cs[i] == '_' || (cs[i] == '.' && !dot && cs.get(i + 1).is_some_and(|d| d.is_ascii_digit()))) {
                dot |= cs[i] == '.';
                i += 1;
            }
            let s: String = cs[start..i].iter().filter(|&&c| c != '_').collect();
            out.push(Tok::Num(s.parse().map_err(|_| format!("bad number {s}"))?));
        } else if c == '"' || c == '\'' || c == '`' {
            let mut s = String::new();
            i += 1;
            while i < cs.len() && cs[i] != c {
                if cs[i] == '\\' && i + 1 < cs.len() {
                    i += 1;
                    s.push(match cs[i] {
                        'n' => '\n',
                        't' => '\t',
                        x => x,
                    });
                } else {
                    s.push(cs[i]);
                }
                i += 1;
            }
            if i >= cs.len() {
                return Err("unclosed string".into());
            }
            i += 1;
            out.push(Tok::Str(s));
        } else if c == '/' && !matches!(out.last(), Some(Tok::Num(_) | Tok::Str(_) | Tok::Ident(_) | Tok::Op(")" | "]"))) {
            // A regular expression literal: /pattern/flags.
            let mut s = String::new();
            i += 1;
            while i < cs.len() && cs[i] != '/' {
                if cs[i] == '\\' && i + 1 < cs.len() {
                    s.push('\\');
                    i += 1;
                }
                s.push(cs[i]);
                i += 1;
            }
            if i >= cs.len() {
                return Err("unclosed regular expression".into());
            }
            i += 1;
            let start = i;
            while i < cs.len() && cs[i].is_ascii_alphabetic() {
                i += 1;
            }
            out.push(Tok::Regex(s, cs[start..i].iter().collect()));
        } else if c.is_alphabetic() || c == '_' || c == '$' {
            let start = i;
            while i < cs.len() && (cs[i].is_alphanumeric() || cs[i] == '_' || cs[i] == '$' || cs[i] == '-' && cs.get(i + 1).is_some_and(|n| n.is_alphabetic())) {
                i += 1;
            }
            let w: String = cs[start..i].iter().collect();
            match w.as_str() {
                "and" => out.push(Tok::Op("&&")),
                "or" => out.push(Tok::Op("||")),
                "not" => out.push(Tok::Op("!")),
                _ => out.push(Tok::Ident(w)),
            }
        } else {
            let rest: String = cs[i..cs.len().min(i + 2)].iter().collect();
            let op = OPS.iter().find(|o| rest.starts_with(**o)).ok_or_else(|| format!("unexpected “{c}”"))?;
            // `=` alone means `==` (a common slip).
            out.push(Tok::Op(op));
            i += op.chars().count();
        }
        if i < cs.len() && cs[i] == '=' && !matches!(out.last(), Some(Tok::Op("==" | "!=" | "<=" | ">="))) && cs.get(i + 1) != Some(&'=') {
            out.push(Tok::Op("=="));
            i += 1;
        }
    }
    Ok(out)
}

#[derive(Clone, Debug)]
pub(super) enum Expr {
    Lit(V),
    Ident(String),
    Member(Box<Expr>, String),
    Index(Box<Expr>, Box<Expr>),
    Call(Box<Expr>, Vec<Expr>),
    Unary(&'static str, Box<Expr>),
    Bin(&'static str, Box<Expr>, Box<Expr>),
    Cond(Box<Expr>, Box<Expr>, Box<Expr>),
}

struct Parser {
    toks: Vec<Tok>,
    i: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.i)
    }
    fn eat(&mut self, op: &str) -> bool {
        if matches!(self.peek(), Some(Tok::Op(o)) if *o == op) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn expect(&mut self, op: &str) -> Result<(), String> {
        if self.eat(op) { Ok(()) } else { Err(format!("expected “{op}”")) }
    }
    fn expr(&mut self) -> Result<Expr, String> {
        let c = self.bin(0)?;
        if self.eat("?") {
            let a = self.expr()?;
            self.expect(":")?;
            let b = self.expr()?;
            return Ok(Expr::Cond(Box::new(c), Box::new(a), Box::new(b)));
        }
        Ok(c)
    }
    fn prec(op: &str) -> Option<u8> {
        Some(match op {
            "||" => 1,
            "&&" => 2,
            "==" | "!=" => 3,
            "<" | "<=" | ">" | ">=" => 4,
            "+" | "-" => 5,
            "*" | "/" | "%" => 6,
            _ => return None,
        })
    }
    fn bin(&mut self, min: u8) -> Result<Expr, String> {
        let mut lhs = self.unary()?;
        loop {
            let Some(Tok::Op(op)) = self.peek().cloned() else { break };
            let Some(p) = Self::prec(op) else { break };
            if p <= min {
                break;
            }
            self.i += 1;
            let rhs = self.bin(p)?;
            lhs = Expr::Bin(op, Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }
    fn unary(&mut self) -> Result<Expr, String> {
        if self.eat("!") {
            return Ok(Expr::Unary("!", Box::new(self.unary()?)));
        }
        if self.eat("-") {
            return Ok(Expr::Unary("-", Box::new(self.unary()?)));
        }
        if self.eat("+") {
            return self.unary();
        }
        self.postfix()
    }
    fn postfix(&mut self) -> Result<Expr, String> {
        let mut e = self.primary()?;
        loop {
            if self.eat(".") {
                match self.peek().cloned() {
                    Some(Tok::Ident(n)) => {
                        self.i += 1;
                        e = Expr::Member(Box::new(e), n);
                    }
                    _ => return Err("expected a name after “.”".into()),
                }
            } else if self.eat("[") {
                let idx = self.expr()?;
                self.expect("]")?;
                e = Expr::Index(Box::new(e), Box::new(idx));
            } else if self.eat("(") {
                let mut args = vec![];
                if !self.eat(")") {
                    loop {
                        args.push(self.expr()?);
                        if self.eat(")") {
                            break;
                        }
                        self.expect(",")?;
                    }
                }
                e = Expr::Call(Box::new(e), args);
            } else {
                break;
            }
        }
        Ok(e)
    }
    fn primary(&mut self) -> Result<Expr, String> {
        let t = self.peek().cloned().ok_or("unexpected end of expression")?;
        self.i += 1;
        Ok(match t {
            Tok::Num(n) => Expr::Lit(V::Num(n)),
            Tok::Str(s) => Expr::Lit(V::Str(s)),
            Tok::Regex(p, f) => {
                let pat = if f.contains('i') { format!("(?i){p}") } else { p };
                Expr::Lit(V::Regex(Regex::new(&pat).map_err(|e| e.to_string())?))
            }
            Tok::Ident(w) => match w.as_str() {
                "true" => Expr::Lit(V::Bool(true)),
                "false" => Expr::Lit(V::Bool(false)),
                "null" => Expr::Lit(V::Null),
                _ => Expr::Ident(w),
            },
            Tok::Op("(") => {
                let e = self.expr()?;
                self.expect(")")?;
                e
            }
            Tok::Op("[") => {
                let mut items = vec![];
                if !self.eat("]") {
                    loop {
                        items.push(self.expr()?);
                        if self.eat("]") {
                            break;
                        }
                        self.expect(",")?;
                    }
                }
                Expr::Call(Box::new(Expr::Ident("list".into())), items)
            }
            Tok::Op(o) => return Err(format!("unexpected “{o}”")),
        })
    }
}

pub(super) fn parse(src: &str) -> Result<Expr, String> {
    let mut p = Parser { toks: lex(src)?, i: 0 };
    let e = p.expr()?;
    if p.i < p.toks.len() {
        return Err(format!("unexpected text after the expression: {:?}", p.toks[p.i]));
    }
    Ok(e)
}
