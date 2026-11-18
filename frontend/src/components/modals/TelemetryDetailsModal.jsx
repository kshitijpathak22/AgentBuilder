import { createPortal } from "react-dom";

const TelemetryDetailsModal = ({
  open,
  onClose,
  data,
}) => {
  if (!open || !data) return null;

  return createPortal(
    <div
      className="telemetry-overlay"
      onClick={onClose}
    >
      <div
        className="telemetry-modal-content"
        onClick={(e) =>
          e.stopPropagation()
        }
      >
        <div className="telemetry-modal-header">
          <h2>Telemetry Details</h2>

          <button
            className="close-button"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="telemetry-modal-body">
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
            }}
          >
            <tbody>
              {[
                ["User", data.username],
                ["Provider", data.provider],
                ["Model", data.model],
                ["Voice", data.voice_id],
                ["Status", data.status],
                [
                  "Duration",
                  `${data.duration_seconds}s`,
                ],
                ["Total Tokens", data.total_tokens],
                ["Prompt Tokens", data.prompt_tokens],
                [
                  "Completion Tokens",
                  data.completion_tokens,
                ],
                [
                  "Total Cost",
                  `$${data.total_cost?.toFixed(
                    6
                  )}`,
                ],
              ].map(([label, value]) => (
                <tr key={label}>
                  <td className="label-cell">
                    {label}
                  </td>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default TelemetryDetailsModal;