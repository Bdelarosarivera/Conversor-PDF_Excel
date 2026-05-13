import { useState } from 'react';

export default function App() {

  const [state, setState] = useState({
    isProcessing: false,
    progress: 0,
    message: ''
  });

  const processPDF = async () => {

    setState({
      isProcessing: true,
      progress: 0,
      message: 'Procesando PDF...'
    });

    try {

      await new Promise(resolve =>
        setTimeout(resolve, 3000)
      );

      setState({
        isProcessing: false,
        progress: 100,
        message: 'PDF procesado correctamente'
      });

    } catch (err) {

      console.error(err);

      setState({
        isProcessing: false,
        progress: 0,
        message: 'Error procesando PDF'
      });
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        flexDirection: 'column',
        gap: '20px',
        fontFamily: 'Arial'
      }}
    >

      <h1>Conversor PDF Excel</h1>

      <button
        onClick={processPDF}
        style={{
          padding: '15px 30px',
          borderRadius: '10px',
          border: 'none',
          background: '#4f46e5',
          color: 'white',
          fontWeight: 'bold',
          cursor: 'pointer'
        }}
      >
        Procesar PDF
      </button>

      {state.isProcessing && (
        <p>
          {state.message}
        </p>
      )}

      {!state.isProcessing &&
        state.progress === 100 && (
        <p>
          PDF procesado correctamente
        </p>
      )}

    </div>
  );
}
