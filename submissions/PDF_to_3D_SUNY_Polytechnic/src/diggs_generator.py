from lxml import etree
from lxml.builder import ElementMaker
import logging
import datetime

logger = logging.getLogger(__name__)

# Namespace Map — note: duplicate "xsi" key removed
NSMAP = {
    None: "http://diggsml.org/schemas/2.6",
    "diggs": "http://diggsml.org/schemas/2.6",
    "xsi": "http://www.w3.org/2001/XMLSchema-instance",
    "xlink": "http://www.w3.org/1999/xlink",
    "gml": "http://www.opengis.net/gml/3.2",
    "witsml": "http://www.witsml.org/schemas/131"
}

# Factory for Elements
E = ElementMaker(nsmap=NSMAP)
DIGGS = ElementMaker(namespace="http://diggsml.org/schemas/2.6", nsmap=NSMAP)
GML = ElementMaker(namespace="http://www.opengis.net/gml/3.2", nsmap=NSMAP)

def generate_diggs_xml(data, output_path):
    """Generates the DIGGS XML file from the mapped data."""

    # Root Element
    root = DIGGS.Diggs(
        {
            "{http://www.w3.org/2001/XMLSchema-instance}schemaLocation": "http://diggsml.org/schemas/2.6 http://diggsml.org/schemas/2.6/Diggs.xsd",
            "{http://www.opengis.net/gml/3.2}id": "DIGGS_Generated_File"
        }
    )

    # 1. Document Information
    creation_date = data["project"]["date"] or datetime.date.today().isoformat()
    doc_info = DIGGS.documentInformation(
        DIGGS.DocumentInformation(
            DIGGS.creationDate(creation_date),
            {"{http://www.opengis.net/gml/3.2}id": "Doc_Info_1"}
        )
    )
    root.append(doc_info)

    # 2. Project
    project = DIGGS.project(
        DIGGS.Project(
            GML.name(data["project"]["name"] or "Unknown Project"),
            {"{http://www.opengis.net/gml/3.2}id": data["project"]["gml_id"]}
        )
    )
    root.append(project)

    # 3. Sampling Feature (Borehole)
    borehole_data = data["borehole"]

    bh_children = [
        GML.name(borehole_data["name"] or "Unknown"),
        DIGGS.investigationTarget("Natural Ground"),
        DIGGS.projectRef(**{"{http://www.w3.org/1999/xlink}href": "#" + data["project"]["gml_id"]}),
        DIGGS.referencePoint(
            DIGGS.PointLocation(
                GML.pos(borehole_data["location"]["pos"]),
                {"{http://www.opengis.net/gml/3.2}id": f"PL_{borehole_data['gml_id']}",
                 "srsName": borehole_data["location"]["srs"],
                 "srsDimension": "3"}
            )
        ),
        DIGGS.centerLine(
            DIGGS.LinearExtent(
                GML.posList(f"{borehole_data['location']['pos']} {borehole_data['location']['pos']}"),
                {"{http://www.opengis.net/gml/3.2}id": f"CL_{borehole_data['gml_id']}", "srsDimension": "3"}
            )
        ),
    ]

    # Add whenConstructed if drill date is available
    if borehole_data.get("drill_date"):
        bh_children.append(
            DIGGS.whenConstructed(
                DIGGS.TimeInterval(
                    DIGGS.start(),
                    DIGGS.end(borehole_data["drill_date"] + "T00:00:00"),
                    {"{http://www.opengis.net/gml/3.2}id": f"Time_{borehole_data['gml_id']}"}
                )
            )
        )

    # Add totalMeasuredDepth if available
    if borehole_data.get("total_depth_ft") is not None:
        bh_children.append(
            DIGGS.totalMeasuredDepth(str(borehole_data["total_depth_ft"]), uom="ft")
        )

    bh_element = DIGGS.Borehole(
        *bh_children,
        **{"{http://www.opengis.net/gml/3.2}id": borehole_data["gml_id"]}
    )

    sampling_feature = DIGGS.samplingFeature(bh_element)
    root.append(sampling_feature)

    # 4. Observations
    for obs in data["observations"]:
        if obs["type"] == "lithology":
            lith_obs = DIGGS.LithologySystem(
                 DIGGS.projectRef(**{"{http://www.w3.org/1999/xlink}href": "#" + data["project"]["gml_id"]}),
                 DIGGS.samplingFeatureRef(**{"{http://www.w3.org/1999/xlink}href": "#" + borehole_data["gml_id"]}),
                 DIGGS.lithologyClassificationType(obs["lith_class_type"]),
                 DIGGS.lithologyObservation(
                     DIGGS.LithologyObservation(
                         DIGGS.location(
                             DIGGS.LinearExtent(
                                 GML.posList(f"{obs['top']} {obs['bottom']}"),
                                 {"{http://www.opengis.net/gml/3.2}id": f"{obs['gml_id']}_extent"}
                             )
                         ),
                         DIGGS.primaryLithology(
                             DIGGS.Lithology(
                                 DIGGS.lithDescription(obs["description"]),
                                 DIGGS.legendCode(obs["lith_class_symbol"], codeSpace="USCS"),
                                 {"{http://www.opengis.net/gml/3.2}id": f"{obs['gml_id']}_lith"}
                             )
                         ),
                         {"{http://www.opengis.net/gml/3.2}id": obs["gml_id"]}
                     )
                 ),
                 {"{http://www.opengis.net/gml/3.2}id": f"System_{obs['gml_id']}"}
            )
            root.append(DIGGS.observation(lith_obs))

        elif obs["type"] == "spt":
            spt_test = DIGGS.Test(
                GML.name("SPT"),
                DIGGS.investigationTarget("Natural Ground"),
                DIGGS.projectRef(**{"{http://www.w3.org/1999/xlink}href": "#" + data["project"]["gml_id"]}),
                DIGGS.samplingFeatureRef(**{"{http://www.w3.org/1999/xlink}href": "#" + borehole_data["gml_id"]}),
                DIGGS.outcome(
                    DIGGS.TestResult(
                         DIGGS.location(
                             DIGGS.LinearExtent(
                                 GML.posList(f"{obs['top']} {obs['bottom']}"),
                                 {"{http://www.opengis.net/gml/3.2}id": f"{obs['gml_id']}_loc"}
                             )
                         ),
                         DIGGS.results(
                             DIGGS.ResultSet(
                                 DIGGS.parameters(
                                     DIGGS.PropertyParameters(
                                         DIGGS.properties(
                                             DIGGS.Property(
                                                 DIGGS.propertyName("N-Value"),
                                                 DIGGS.typeData("integer"),
                                                 DIGGS.propertyClass("n_value", codeSpace="https://diggsml.org/def/codes/DIGGS/0.1/properties.xml#n_value"),
                                                 **{"index": "1", "{http://www.opengis.net/gml/3.2}id": f"{obs['gml_id']}_prop"}
                                             )
                                         ),
                                         **{"{http://www.opengis.net/gml/3.2}id": f"{obs['gml_id']}_params"}
                                     )
                                 ),
                                 DIGGS.dataValues(str(obs["n_value"]), cs=",", ts=" ", decimal=".")
                             )
                         ),
                         {"{http://www.opengis.net/gml/3.2}id": f"{obs['gml_id']}_result"}
                    )
                ),
                {"{http://www.opengis.net/gml/3.2}id": obs["gml_id"]}
            )
            root.append(DIGGS.measurement(spt_test))

    # Write to file
    tree = etree.ElementTree(root)
    tree.write(output_path, pretty_print=True, xml_declaration=True, encoding="UTF-8")
    logger.info(f"Successfully generated {output_path}")
