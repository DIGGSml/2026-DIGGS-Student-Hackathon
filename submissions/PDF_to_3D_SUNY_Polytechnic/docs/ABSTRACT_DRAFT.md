# Conference Abstract — DRAFT
### Send to Professor by March 4, 2026

---

Geotechnical site investigation data is routinely recorded in PDF-format borehole logs that remain locked in unstructured, human-readable documents, making automated analysis and cross-site comparison difficult. This work presents a prototype software pipeline that transforms raw PDF borehole logs — specifically Virginia Department of Transportation (VDOT) standard format logs — into standardized, machine-readable data and interactive three-dimensional soil-profile visualizations. The system employs a Python-based extraction and validation engine to parse borehole metadata, stratigraphy, and Standard Penetration Test (SPT) results directly from PDF files, converting them first into the DIGGS 2.6 XML schema — an industry-standard geotechnical data interchange format — and subsequently into Microsoft Excel, making the structured data immediately accessible to practicing engineers without specialized software. The resulting tabular data is then used to automatically generate interactive, rotatable 3D soil-profile visualizations in which distinct soil types (sand, silt, clay, and rock) are rendered as color-coded volumetric layers across multiple borehole locations, enabling rapid spatial interpretation of subsurface conditions along a survey profile. This integrated workflow, demonstrated through a web-based application, represents a significant step toward bridging the gap between legacy geotechnical documentation practices and modern data-driven site characterization, with a readily extensible architecture designed to accommodate diverse borehole log formats in future work.

---

> **Word count:** ~185 words  
> **Key terms:** VDOT, DIGGS 2.6, PDF extraction, XML, Excel, 3D visualization, SPT, stratigraphy
