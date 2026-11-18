import React from "react";
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  BarElement,
} from "chart.js";
import { Doughnut } from "react-chartjs-2";
import { Bar } from "react-chartjs-2";

import {
  Coins,
  Clock3,
  DollarSign,
} from "lucide-react";

ChartJS.register(
  ArcElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  BarElement
);

import { useEffect, useState } from "react";
import {
  getTelemetryOverview,
  getTelemetryModels,
  getTelemetryUsers,
  getRecentTelemetry,
} from "../services/api";

import XLSX from "xlsx-js-style";
import { saveAs } from "file-saver";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

import {
  Download,
  FileSpreadsheet,
  FileText,
  ChevronDown,
} from "lucide-react";





/* table styles */
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' };
const tableScrollStyle = { overflow: 'auto', maxHeight: '520px', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)' };
const Th = ({ children, align, last }) => (
  <th style={{
    padding: '0.7rem 0.8rem', textAlign: align || 'left', color: 'var(--text-secondary)', fontWeight: 600,
    borderBottom: '1px solid var(--border-strong)', borderRight: last ? 'none' : '1px solid var(--border-default)',
    whiteSpace: 'nowrap', position: 'sticky', top: 0, background: 'var(--bg-card)', zIndex: 1,
  }}>{children}</th>
);
const Td = ({ children, align, colSpan, last, style: extra }) => (
  <td colSpan={colSpan} style={{
    padding: '0.6rem 0.8rem', textAlign: align || 'left', color: 'var(--text-secondary)',
    borderBottom: '1px solid var(--border-default)', borderRight: last ? 'none' : '1px solid var(--border-default)',
    ...extra,
  }}>{children}</td>
);


const AdminTelemetry = ({
  onOpenTelemetry,
}) => {

const [showExportMenu, setShowExportMenu] =
  useState(false);

const [search, setSearch] =
  useState("");

const [users, setUsers] =
  useState([]);


const exportToExcel = () => {
  const workbook = XLSX.utils.book_new();

  // Summary Sheet
 const summaryData = [
  {
    Metric: "Total Tokens",
    Value: overview.total_tokens,
  },
  {
    Metric: "Total Calls",
    Value: overview.total_calls,
  },
  {
    Metric: "Average Latency (s)",
    Value: overview.average_duration_seconds.toFixed(2),
  },
  {
    Metric: "Total Cost",
    Value: overview.total_cost.toFixed(6),
  },

  {
    Metric: "Text Input Tokens",
    Value: overview.text_input_tokens,
  },
  {
    Metric: "Text Output Tokens",
    Value: overview.text_output_tokens,
  },
  {
    Metric: "Audio Input Tokens",
    Value: overview.audio_input_tokens,
  },
  {
    Metric: "Audio Output Tokens",
    Value: overview.audio_output_tokens,
  },

  {
    Metric: "Prompt Ratio %",
    Value: promptPercent,
  },
  {
    Metric: "Completion Ratio %",
    Value: completionPercent,
  },
];



  const summarySheet =
    XLSX.utils.json_to_sheet(summaryData);

  XLSX.utils.book_append_sheet(
    workbook,
    summarySheet,
    "Summary"
  );

  
  // Models Sheet
  const modelSheet =
    XLSX.utils.json_to_sheet(models);

  XLSX.utils.book_append_sheet(
    workbook,
    modelSheet,
    "Models"
  );

  // Users Sheet
  const userSheet =
    XLSX.utils.json_to_sheet(users);

  XLSX.utils.book_append_sheet(
    workbook,
    userSheet,
    "Users"
  );

  summarySheet["!cols"] = [
  { wch: 30 },
  { wch: 20 },
];

modelSheet["!cols"] = [
  { wch: 35 }, // model
  { wch: 20 }, // provider
  { wch: 15 }, // calls
  { wch: 15 }, // tokens
  { wch: 15 }, // cost
];

userSheet["!cols"] = [
  { wch: 35 }, // username
  { wch: 10 }, // calls
  { wch: 15 },
  { wch: 15 },
  { wch: 15 },
  { wch: 15 },
  { wch: 15 },
  { wch: 15 },
];

const headerStyle = {
  font: {
    bold: true,
    color: { rgb: "FFFFFF" },
  },
  fill: {
    fgColor: { rgb: "2952E3" },
  },
  alignment: {
    horizontal: "center",
    vertical: "center",
  },
};



  const excelBuffer = XLSX.write(workbook, {
    bookType: "xlsx",
    type: "array",
  });

  saveAs(
    new Blob([excelBuffer]),
    `Telemetry_Report_${new Date()
      .toISOString()
      .split("T")[0]}.xlsx`
  );
};

const exportToPdf = () => {
  const doc = new jsPDF();

  
  doc.setFontSize(18);
  doc.text("Telemetry Report", 14, 20);

  doc.setFontSize(10);
  doc.text(
    `Generated: ${new Date().toLocaleString()}`,
    14,
    28
  );

  
  // Summary
 autoTable(doc, {
  startY: 35,
  head: [["Metric", "Value"]],
  body: [
    ["Total Tokens", overview.total_tokens],
    ["Total Calls", overview.total_calls],
    ["Avg Latency", `${overview.average_duration_seconds.toFixed(2)}s`],
    ["Total Cost", `$${overview.total_cost.toFixed(6)}`],

    ["Text Input", overview.text_input_tokens],
    ["Text Output", overview.text_output_tokens],
    ["Audio Input", overview.audio_input_tokens],
    ["Audio Output", overview.audio_output_tokens],
  ],
});

  // Models
  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 10,
    head: [["Model", "Provider", "Calls", "Tokens"]],
    body: models.map((m) => [
      m.model,
      m.provider,
      m.total_calls,
      m.total_tokens,
    ]),
  });

  // Users
  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 10,
    head: [
      [
        "User",
        "Calls",
        "Tokens",
        "Input",
        "Output",
        "Cost",
      ],
    ],
    body: users.map((u) => [
      u.username,
      u.total_calls,
      u.total_tokens,
      u.text_input_tokens +
        u.audio_input_tokens,
      u.text_output_tokens +
        u.audio_output_tokens,
      `$${u.total_cost.toFixed(6)}`,
    ]),
  });

  doc.save("Telemetry_Report.pdf");
};

const [overview, setOverview] =
  useState(null);

const [models, setModels] =
  useState([]);

  

const [recentUsage, setRecentUsage] = useState(null);




useEffect(() => {
  loadTelemetry();
}, []);

const loadTelemetry = async () => {
  try {
    const [
  overviewResponse,
  modelsResponse,
  usersResponse,
  recentTelemetryResponse,
] = await Promise.all([
  getTelemetryOverview(),
  getTelemetryModels(),
  getTelemetryUsers(),
  getRecentTelemetry(),
]);

    setOverview(overviewResponse);
    setModels(modelsResponse.models || []);
    setUsers(usersResponse.users || []);
    setRecentUsage(recentTelemetryResponse?.usage?.[0] || null );
  } catch (error) {
    console.error(error);
  }
};



if (!overview) {
  return (
    <div
      style={{
        padding: "24px",
      }}
    >
      Loading Telemetry...
    </div>
  );
}

const inputTokens =
  (overview.text_input_tokens ||
    0) +
  (overview.audio_input_tokens ||
    0);

const outputTokens =
  overview.text_output_tokens +
  overview.audio_output_tokens;

 const promptPercent =
  Math.round(
    (inputTokens /
      (inputTokens +
        outputTokens)) *
      100
  );

const completionPercent =
  100 - promptPercent;

 const chartData = {
  labels: [
    "Text Input",
    "Text Output",
    "Audio Input",
    "Audio Output",
  ],
  datasets: [
    {
      label: "Tokens",
      data: [
        overview.text_input_tokens,
        overview.text_output_tokens,
        overview.audio_input_tokens,
        overview.audio_output_tokens,
      ],
      backgroundColor: [
        "#2952E3",
        "#4F46E5",
        "#06B6D4",
        "#8B5CF6",
      ],
      borderRadius: 8,
      borderSkipped: false,
    },
  ],
};

  const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      display: false,
    },
  },
  scales: {
    x: {
      grid: {
        display: false,
      },
      ticks: {
        color: "#94a3b8",
      },
    },
    y: {
      grid: {
        color: "rgba(148,163,184,0.1)",
      },
      ticks: {
        color: "#94a3b8",
      },
    },
  },
};

  const formatNumber = (num) => {
    if (num >= 1000000)
      return `${(
        num / 1000000
      ).toFixed(1)}M`;

    if (num >= 1000)
      return `${(
        num / 1000
      ).toFixed(1)}K`;

    return num;
  };

  return (


    
    <div
      style={{
        
        background: "var(--bg-page)",
        
      }}
    >
      
<div
  style={{
    display: "flex",
    justifyContent: "space-between",
    marginBottom: "20px",
  }}
>
  <h2>Telemetry Dashboard</h2>

  <div
  style={{
    position: "relative",
  }}
>
  <button
    onClick={() =>
      setShowExportMenu(!showExportMenu)
    }
    style={{
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "10px 16px",
      background: "#2952E3",
      color: "#fff",
      border: "none",
      borderRadius: "10px",
      cursor: "pointer",
      fontWeight: "600",
      boxShadow:
        "0 4px 12px rgba(41,82,227,0.25)",
    }}
  >
    <Download size={16} />
    Export
    <ChevronDown size={16} />
  </button>

  {showExportMenu && (
    <div
      style={{
        position: "absolute",
        top: "46px",
        right: 0,
        width: "200px",
        background: "var(--bg-card)",
        border:
          "1px solid var(--border-default)",
        borderRadius: "12px",
        boxShadow:
          "0 10px 30px rgba(0,0,0,0.12)",
        overflow: "hidden",
        zIndex: 999,
      }}
    >
      <button
        onClick={() => {
          exportToExcel();
          setShowExportMenu(false);
        }}
        style={{
          width: "100%",
          padding: "12px 16px",
          border: "none",
          background: "transparent",
          color: "var(--text-primary)",
          display: "flex",
          alignItems: "center",
          gap: "10px",
          cursor: "pointer",
        }}
      >
        <FileSpreadsheet
          size={18}
          color="#16A34A"
        />
        Export Excel
      </button>

      <button
        onClick={() => {
          exportToPdf();
          setShowExportMenu(false);
        }}
        style={{
          width: "100%",
          padding: "12px 16px",
          border: "none",
          background: "transparent",
          color: "var(--text-primary)",
          display: "flex",
          alignItems: "center",
          gap: "10px",
          cursor: "pointer",
          borderTop:
            "1px solid var(--border-default)",
        }}
      >
        <FileText
          size={18}
          color="#DC2626"
        />
        Export PDF
      </button>
    </div>
  )}
</div>
</div>

      <div
        className="admin-telemetry-container"
      >
        {/* LEFT CARD */}

        <div
          style={{
            background: "var(--bg-card)",
            borderRadius: "12px",
            border:
              "1px solid var(--border-default)",
            padding: "24px",
          }}
          className="admin-telemetry-Left"
        >
          {/* Header */}

<div className="tokenCrds">
            {[
              {
                value: formatNumber(
                  overview.total_tokens
                ),
                label:
                  "TOTAL TOKENS",
                  icon: <Coins size={24} />,
              },
              
              {
                value: `${overview.average_duration_seconds.toFixed(1)}s`,
                label:
                  "AVG LATENCY",
                  icon: <Clock3 size={24} />,
              },
              
              
              {
                value: `$${overview.total_cost.toFixed(6)}`,
                label:
                  "TOTAL COST",
                  icon: <DollarSign size={24} />,
                color:
                  "#059669",
              },
            ].map(
              (
                item,
                index
              ) => (
                <div
                  key={index}
                  className="tokenCrdList"
                >
                  <span className="card-icon card-icon-square card-icon-blue">
                    {item.icon}
                  </span>
                  <div>
                  <h2
                  >
                    {
                      item.value
                    }
                  </h2>

                  <p
                    
                  >
                    {
                      item.label
                    }
                  </p>
                  </div>
                </div>
              )
            )}
          </div>

          <div
            style={{
              display: "flex",
              justifyContent:
                "space-between",
              alignItems: "center",
              marginBottom: "20px",
            }}
          >
            <h2
              style={{
                margin: 0,
                fontSize: "24px",
                color: "var(--text-primary)"
              }}
            >
              Token Usage Breakdown
            </h2>

            <span
              style={{
                background:
                  "var(--bg-surface)",
                color: "var(--accent-primary)",
                border: "1px solid var(--border-default)",
                padding:
                  "8px 16px",
                borderRadius:
                  "20px",
                fontWeight: 600,
              }}
            >
              {overview.total_calls} calls
            </span>
          </div>

          {/* Chart */}

          <div
            style={{
              display: "flex",
              justifyContent:
                "center",
              position: "relative",
              height: "320px",
            }}
          >
            <div
  style={{
    width: "100%",
    height: "330px",
    marginBottom: "24px",
  }}
>
  <Bar
    data={chartData}
    options={chartOptions}
  />
</div>

            
          </div>

          {/* Legends */}

          <div
  style={{
    display: "flex",
    justifyContent: "center",
    gap: "30px",
    marginBottom: "20px",
    marginTop: "20px",
    flexWrap: "wrap",
  }}
>
  <span>
  🟦 Text Input: {overview.text_input_tokens}
</span>

<span>
  🟪 Text Output: {overview.text_output_tokens}
</span>

<span>
  🔷 Audio Input: {overview.audio_input_tokens}
</span>

<span>
  🟣 Audio Output: {overview.audio_output_tokens}
</span>
</div>

          {/* Stats */}

          

          {/* Ratio */}

          <div
            style={{
              marginTop: "40px",
            }}
          >
            <h3>
              PROMPT /
              COMPLETION
              RATIO
            </h3>

            <div
              style={{
                display: "flex",
                height: "12px",
                borderRadius:
                  "20px",
                overflow:
                  "hidden",
                marginBottom:
                  "10px",
              }}
            >
              <div
                style={{
                  width: `${promptPercent}%`,
                  background:
                    "#2952E3",
                }}
              />

              <div
                style={{
                  width: `${completionPercent}%`,
                  background:
                    "#1890FF",
                }}
              />
            </div>

            <div
              style={{
                display: "flex",
                justifyContent:
                  "space-between",
              }}
            >
              <span>
                Prompt{" "}
                <b>
                  {
                    promptPercent
                  }
                  %
                </b>
              </span>

              <span>
                Completion{" "}
                <b>
                  {
                    completionPercent
                  }
                  %
                </b>
              </span>
            </div>
          </div>
        </div>

        {/* RIGHT PANEL */}

        <div
        className="admin-telemetry-Rgt"
          style={{
            background: "var(--bg-card)",
            borderRadius: "12px",
            border:
              "1px solid var(--border-default)",
            padding: "24px",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent:
                "space-between",
              alignItems:
                "center",
              marginBottom:
                "20px",
            }}
          >
            <h2
              style={{
                margin: 0,
              }}
            >
              Model Insights
            </h2>

            <span
              style={{
               background:"var(--bg-surface)",
color: "var(--accent-primary)",
border: "1px solid var(--border-default)",
                padding:
                  "8px 14px",
                borderRadius:
                  "20px",
              }}
            >
              {models.length} model
{models.length > 1
  ? "s"
  : ""}
            </span>
          </div>

          {models.map(
            (model) => (
              <div
                key={
                  model.model
                }
                style={{
                  border:
              "1px solid var(--border-default)",
                  borderRadius:
                    "16px",
                  padding:
                    "20px",
                }}
              >
                <div
                  style={{
                    display:
                      "flex",
                    justifyContent:
                      "space-between",
                  }}
                >
                  <h3>
                    {
                      model.model
                    }
                  </h3>

                  <span>
                    100%
                  </span>
                </div>

                <div
                  style={{
                    height:
                      "10px",
                    background:
                      "#e5e7eb",
                    borderRadius:
                      "20px",
                    overflow:
                      "hidden",
                    marginBottom:
                      "20px",
                  }}
                >
                  <div
                    style={{
                      width:
                        "100%",
                      height:
                        "100%",
                      background:
                        "#2952E3",
                    }}
                  />
                </div>

                <ul
                  
                >
                  <li>
                    Total <b>{formatNumber(model.total_tokens)}</b>
                  </li>

                  <li>
                   Calls <b>{model.total_calls}</b>
                  </li>

                  <li>
                   Provider <b>{model.provider}</b>
                  </li>

                  

                  <li>
                    Cost <b>${model.total_cost.toFixed(6)}</b>
                  </li>
                </ul>


                
              </div>
            )
          )}

          <div
            style={{
              marginTop:
                "auto",
              paddingTop:
                "30px",
              color:
                "#6b7280",
              fontSize:
                "14px",
            }}
          >
            Avg {Math.round(
  overview.total_tokens /
  overview.total_calls
)} tokens/call · Top model {models?.[0]?.model || "-"}
          </div>

{recentUsage && (
  <div
    style={{
      marginTop: "20px",
      border: "1px solid var(--border-default)",
      borderRadius: "16px",
      padding: "20px",
      background: "var(--bg-surface)",
    }}
  >
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        marginBottom: "16px",
      }}
    >
      <h3 style={{ margin: 0 }}>
        Latest Session
      </h3>

      <span
        style={{
          background: "#dcfce7",
          color: "#16a34a",
          padding: "4px 10px",
          borderRadius: "12px",
          fontSize: "12px",
          fontWeight: "600",
        }}
      >
        {recentUsage.status}
      </span>
    </div>

    <div style={{ marginBottom: "10px" }}>
      <strong>Model:</strong>{" "}
      {recentUsage.model}
    </div>

    <div style={{ marginBottom: "10px" }}>
      <strong>Voice:</strong>{" "}
      {recentUsage.voice_id}
    </div>

    <div style={{ marginBottom: "10px" }}>
      <strong>Duration:</strong>{" "}
      {recentUsage.duration_seconds}s
    </div>

    <div style={{ marginBottom: "10px" }}>
      <strong>Tokens:</strong>{" "}
      {formatNumber(recentUsage.total_tokens)}
    </div>

    <div style={{ marginBottom: "10px" }}>
      <strong>Cost:</strong> $
      {recentUsage.total_cost.toFixed(6)}
    </div>

    <button
     onClick={() => {
  console.log("clicked");
  onOpenTelemetry(recentUsage);
}}
      style={{
        width: "100%",
        marginTop: "10px",
        padding: "10px",
        border: "none",
        borderRadius: "10px",
        cursor: "pointer",
        color: "#fff",
        background:
          "linear-gradient(90deg,#2952E3,#7C3AED)",
      }}
    >
      View Details
    </button>
  </div>
)}


        </div>
      </div>

<div
  style={{
    marginTop: "30px",
    background: "var(--bg-card)",
    borderRadius: "20px",
    border: "1px solid var(--border-default)",
    padding: "24px",
  }}
>
  <div
    style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: "20px",
    }}
  >
    <h2>
      Token Usage By User
    </h2>

    <span
      style={{
       background:"var(--bg-surface)",
color: "var(--accent-primary)",
border: "1px solid var(--border-default)",
        padding: "8px 16px",
        borderRadius: "999px",
        fontWeight: "600",
      }}
    >
      {users.length} Users
    </span>
  </div>

  <input
    placeholder="Search user..."
    style={{
      width: "300px",
      padding: "12px",
      borderRadius: "10px",
      border: "1px solid #ddd",
      marginBottom: "20px",
    }}
  />

  
<div style={tableScrollStyle}>
    <table style={tableStyle} className="ctmTbl">
      <thead>
        <tr>
          <th>#</th>
          <th>User</th>
          <th>Calls</th>
          <th>Tokens</th>
          <th>Input</th>
          <th>Output</th>
          <th>Cost</th>
        </tr>
      </thead>

      <tbody>
        {users.map(
          (user, index) => {
            const input =
              user.text_input_tokens +
              user.audio_input_tokens;

            const output =
              user.text_output_tokens +
              user.audio_output_tokens;

            return (
              
                <tr key={user.username} style={{ borderBottom: '1px solid var(--border-default)' }}>
                <td>
                  <div
                    style={{
                      width: "32px",
                      height: "32px",
                      borderRadius:
                        "50%",
                      background:
                        "#2952E3",
                      color:
                        "#fff",
                      display:
                        "flex",
                      justifyContent:
                        "center",
                      alignItems:
                        "center",
                    }}
                  >
                    {index + 1}
                  </div>
                </td>

                <td>
                  <div>
                    <strong>
                      {
                        user.username
                      }
                    </strong>
                  </div>
                </td>

                <td>
                  <span
                    style={{
                      background:
                        "var(--sc-bg)",
                        border:"1px solid var(--border-default)",
                      padding:
                        "6px 12px",
                      borderRadius:
                        "999px",
                    }}
                  >
                    {
                      user.total_calls
                    }
                  </span>
                </td>

                <td>
                  <strong>
                    {formatNumber(
                      user.total_tokens
                    )}
                  </strong>
                </td>

                <td>
                  {formatNumber(
                    input
                  )}
                </td>

                <td>
                  {formatNumber(
                    output
                  )}
                </td>

                <td>
                  <span
                    style={{
                      color:
                        "#059669",
                      fontWeight:
                        700,
                    }}
                  >
                    $
                    {user.total_cost.toFixed(
                      6
                    )}
                  </span>
                </td>
              </tr>
            );
          }
        )}
      </tbody>
    </table>
  </div>
</div>



    </div>

    
  );
  
};






export default AdminTelemetry;