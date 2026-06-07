# Brand fonts (US-654)

The app's display + body typefaces, bundled and registered via
`UIAppFonts` (see `project.yml`) and exposed through the `Font` /
`BrandFont` scale in `GradeThread/Theme/Typography.swift`.

| Family | Role | Weights bundled |
|---|---|---|
| **Outfit** | Display (titles, section headers, grade-score number, certificate titles) | Regular, SemiBold, Bold |
| **Inter** | Body / UI / tabular data (with `.monospacedDigit()`) | Regular, Medium, Bold |

These are static weights **instanced from the upstream OFL variable
fonts** (so SwiftUI's `Font.custom(_:)` resolves each weight by its exact
PostScript name — `Outfit-SemiBold`, `Inter-Regular`, etc.). Outfit's
variable default instance is *Thin*, which is why we ship pinned static
weights rather than the raw variable file.

## License

Both families are licensed under the **SIL Open Font License 1.1**.

- **Inter** © The Inter Project Authors — https://github.com/rsms/inter
- **Outfit** © The Outfit Project Authors — https://github.com/Outfitio/Outfit-Fonts

The OFL permits bundling/redistribution in software. Keep this attribution
with the font files.
