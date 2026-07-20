interface Props {
  projectName: string;
  ports: number[];
  onPick: (port: number) => void;
  onClose: () => void;
}

export function PortPickerModal({ projectName, ports, onPick, onClose }: Props) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Abrir {projectName} em qual porta?</h2>
        <div className="port-picker-list">
          {ports.map((port) => (
            <button
              key={port}
              type="button"
              className="btn port-picker-option"
              onClick={() => {
                onPick(port);
                onClose();
              }}
            >
              localhost:{port}
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
