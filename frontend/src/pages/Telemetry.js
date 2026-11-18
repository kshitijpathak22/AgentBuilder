import React from "react";
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
} from "chart.js";
import { Doughnut } from "react-chartjs-2";

ChartJS.register(
  ArcElement,
  Tooltip,
  Legend
);

import { useEffect, useState } from "react";
import {
  getTelemetryOverview,
  getTelemetryModels,
  getTelemetryUsers,
  getRecentTelemetry,
} from "../services/api";


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


const Telemetry = () => {

const [search, setSearch] =
  useState("");

const [users, setUsers] =
  useState([]);




const [overview, setOverview] =
  useState(null);

const [models, setModels] =
  useState([]);

  
const [showModal, setShowModal] = useState(false);
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
    "Input Tokens",
    "Output Tokens",
  ],
  datasets: [
    {
      data: [
        inputTokens,
        outputTokens,
      ],
      backgroundColor: [
        "#2952E3",
        "#1890FF",
      ],
      borderWidth: 0,
    },
  ],
};

  const chartOptions = {
    cutout: "70%",
    plugins: {
      legend: {
        display: false,
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
        minHeight: "100vh",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "2fr 1fr",
          gap: "20px",
        }}
      >
        {/* LEFT CARD */}

        <div
          style={{
            background: "var(--bg-card)",
            borderRadius: "20px",
            border:
              "1px solid var(--border-default)",
            padding: "24px",
          }}
        >
          {/* Header */}

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
              LLM Token Usage
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
                width: "320px",
              }}
            >
              <Doughnut
                data={chartData}
                options={chartOptions}
              />
            </div>

            <div
              style={{
                position: "absolute",
                top: "50%",
                left: "50%",
                transform:
                  "translate(-50%,-50%)",
                textAlign: "center",
              }}
            >
              <h1
                style={{
                  margin: 0,
                  fontSize: "38px",
                }}
              >
                {formatNumber(
                  overview.total_tokens
                )}
              </h1>

              <span
                style={{
                  color: "var(--text-muted)",
                }}
              >
                total tokens
              </span>
            </div>
          </div>

          {/* Legends */}

          <div
            style={{
              display: "flex",
              justifyContent:
                "center",
              gap: "40px",
              marginBottom: "30px",
            }}
          >
            <div>
              🔵 Prompt Tokens{" "}
              {formatNumber(inputTokens)}
            </div>

            <div>
              🔹 Completion Tokens{" "}
              {formatNumber(outputTokens)}
            </div>
          </div>

          {/* Stats */}

          <div
          className="tokenCrds"
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(3,1fr)",
              gap: "16px",
            }}
          >
            {[
              {
                value: formatNumber(
                  overview.total_tokens
                ),
                label:
                  "TOTAL TOKENS",
              },
              {
                value:
                  overview.total_calls,
                label:
                  "LLM CALLS",
              },
              {
                value: `${overview.average_duration_seconds.toFixed(1)}s`,
                label:
                  "AVG LATENCY",
              },
              {
                value: `N/A`,
                label:
                  "INPUT COST",
                color:
                  "#2563eb",
              },
              {
                value: `N/A`,
                label:
                  "OUTPUT COST",
                color:
                  "#0284c7",
              },
              {
                value: `$${overview.total_cost.toFixed(6)}`,
                label:
                  "TOTAL COST",
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
                  style={{
                    
                    padding:
                      "24px",
                    borderRadius:
                      "16px",
                    textAlign:
                      "center",
                  }}
                >
                  <h2
                    style={{
                      margin: 0,
                      color:
                        item.color ||
                        "#111",
                    }}
                  >
                    {
                      item.value
                    }
                  </h2>

                  <p
                    style={{
                      marginTop:
                        "10px",
                      color:
                        "var(--text-muted)",
                      fontSize:
                        "12px",
                    }}
                  >
                    {
                      item.label
                    }
                  </p>
                </div>
              )
            )}
          </div>

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
          style={{
            background: "var(--bg-card)",
            borderRadius: "20px",
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
                    "1px solid #eee",
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

                <div
                  style={{
                    display:
                      "flex",
                    flexWrap:
                      "wrap",
                    gap: "10px",
                  }}
                >
                  <span>
                    Total {formatNumber(model.total_tokens)}
                  </span>

                  <span>
                   Calls {model.total_calls}
                  </span>

                  <span>
                   Provider {model.provider}
                  </span>

                  

                  <span>
                    Cost ${model.total_cost.toFixed(6)}
                  </span>
                </div>


                
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
          borderRadius: "20px",
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
     onClick={() => {console.log("clicked"); setShowModal(true);}}
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
        background: "#eef2ff",
        color: "#2952E3",
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
                        "#e0f2fe",
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

{showModal && recentUsage && (
  <div
    style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.7)",
      zIndex: 9999,
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
    }}
  >
    <div
      style={{
        width: "1100px",
        maxWidth: "90vw",
        overflowY: "auto",
        background: "var(--bg-card)",
        borderRadius: "20px",
        padding: "24px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: "20px",
        }}
      >
        <h2>Telemetry Details</h2>

        <button className="close-button"
          onClick={() =>
            setShowModal(false)
          }
        >
          ✕
        </button>
      </div>

      <pre>
        
        {recentUsage && (
  <div
    style={{
      marginTop: "20px",
      border: "1px solid var(--border-default)",
      borderRadius: "16px",
      padding: "16px",
      overflowX: "auto",
    }}
  >
    <h3 style={{ marginBottom: "16px" }}>
      Session Details
    </h3>

    <table
      style={{
        width: "100%",
        borderCollapse: "collapse",
      }}
    >
      <tbody>
        <tr>
          <td><strong>User</strong></td>
          <td>{recentUsage.username}</td>
        </tr>

        <tr>
          <td><strong>Provider</strong></td>
          <td>{recentUsage.provider}</td>
        </tr>

        <tr>
          <td><strong>Model</strong></td>
          <td>{recentUsage.model}</td>
        </tr>

        <tr>
          <td><strong>Voice</strong></td>
          <td>{recentUsage.voice_id}</td>
        </tr>

        <tr>
          <td><strong>Status</strong></td>
          <td>{recentUsage.status}</td>
        </tr>

        <tr>
          <td><strong>Duration</strong></td>
          <td>{recentUsage.duration_seconds}s</td>
        </tr>

        <tr>
          <td><strong>Total Tokens</strong></td>
          <td>{recentUsage.total_tokens}</td>
        </tr>

        <tr>
          <td><strong>Prompt Tokens</strong></td>
          <td>{recentUsage.prompt_tokens}</td>
        </tr>

        <tr>
          <td><strong>Completion Tokens</strong></td>
          <td>{recentUsage.completion_tokens}</td>
        </tr>

        <tr>
          <td><strong>Total Cost</strong></td>
          <td>
            ${recentUsage.total_cost?.toFixed(6)}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
)}


      </pre>
    </div>
  </div>
)}

    </div>
  );
};






export default Telemetry;