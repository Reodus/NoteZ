---
title: نمایش قابلیت‌های NoteZ
subtitle: A bilingual showcase — یک سند دوزبانه
author: NoteZ
date: today
theme: default
toc: false
---

# مقدمه

این سند همهٔ قابلیت‌های **NoteZ** را نشان می‌دهد. متن فارسی راست‌به‌چپ و متن انگلیسی چپ‌به‌راست چیده می‌شود، حتی در یک سند واحد.

This paragraph is English, so it is laid out left-to-right with English hyphenation.

ترکیب *کلمات English* وسط جملهٔ فارسی هم درست نمایش داده می‌شود. یک [کلمهٔ رنگی]{color=#c0392b} و یک [متن هایلایت‌شده]{highlight=#fff3a3} و [زیرخط‌دار]{underline}.

::: {align=center}
این پاراگراف وسط‌چین است.
:::

## فرمول‌ها

فرمول درون‌خطی: $E = mc^2$ و فرمول نمایشی:

$$
\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}
$$

## نمودار میله‌ای

```chart
type: bar
title: فروش فصلی
ylabel: میلیون تومان
labels: [بهار, تابستان, پاییز, زمستان]
series:
  - name: ۱۴۰۲
    values: [12, 18, 9, 14]
  - name: ۱۴۰۳
    values: [15, 21, 13, 17]
```

## نمودار خطی

```chart
type: line
title: Growth
x: [1, 2, 3, 4, 5, 6]
series:
  - name: Users
    values: [3, 5, 9, 14, 22, 35]
  - name: Revenue
    values: [1, 2, 4, 7, 11, 18]
smooth: true
```

## نمودار دایره‌ای

```chart
type: donut
title: سهم بازار
data:
  محصول الف: 45
  محصول ب: 30
  محصول ج: 15
  سایر: 10
```

## فلوچارت

```flow
A([شروع]) -> B[دریافت ورودی] -> C{معتبر است؟}
C -> D[پردازش] : بله
C --> B : خیر
D -> E((پایان))
```

## نقشهٔ ذهنی

```mindmap
NoteZ
  ویرایشگر
    راست‌به‌چپ
    Markdown
  PDF
    Typst
    Themes
  نمودار
    Charts
    Flowcharts
```

## خط زمانی

```timeline
۱۴۰۰: ایده
۱۴۰۱: نسخهٔ اول
۱۴۰۲: پلاگین‌ها
۱۴۰۳: انتشار
```

## اشکال

```draw
circle((0, 0), radius: 1, fill: rgb("#4e79d6").lighten(60%), stroke: rgb("#4e79d6"))
rect((1.6, -1), (3.6, 1), radius: 0.2, fill: rgb("#f28e2b").lighten(60%), stroke: rgb("#f28e2b"))
line((4.2, -1), (5.2, 1), (6.2, -1), close: true, fill: rgb("#3fb68b").lighten(60%), stroke: rgb("#3fb68b"))
content((0, 0), [دایره])
content((2.6, 0), [Square])
```

## جدول

| ویژگی | Obsidian | NoteZ |
|:------|:--------:|------:|
| PDF حرفه‌ای | ✗ | ✓ |
| راست‌به‌چپ | نیمه | ✓ |
| نمودار | پلاگین | داخلی |

## فهرست‌ها

- مورد اول
- Second item
  - زیرمورد
- [x] کار انجام‌شده
- [ ] کار باقی‌مانده

1. گام اول
2. گام دوم

> [!NOTE]
> این یک یادداشت (callout) است.

> نقل‌قول معمولی با سبک مخصوص خودش.

```rust
fn main() {
    println!("Code blocks are always left-to-right");
}
```

متن با پانویس[^1].

[^1]: این متن پانویس است.
