function titleCaseKey(key) {
  return String(key).replace(/_/g, " ");
}

export function DynamicOutput({ data }) {
  if (data === null || data === undefined) {
    return <p className="dyn-empty">No data</p>;
  }
  if (typeof data === "string") {
    return <p className="dyn-p">{data}</p>;
  }
  if (typeof data === "number" || typeof data === "boolean") {
    return <p className="dyn-p">{String(data)}</p>;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return <p className="dyn-empty">(empty list)</p>;
    }
    const allPrimitive = data.every(
      (x) =>
        x === null ||
        ["string", "number", "boolean"].includes(typeof x) ||
        (typeof x === "object" && !Array.isArray(x) && x !== null)
    );
    if (
      allPrimitive &&
      data.every((x) => typeof x !== "object" || x === null)
    ) {
      return (
        <ul className="dyn-list">
          {data.map((item, i) => (
            <li key={i}>{String(item)}</li>
          ))}
        </ul>
      );
    }
    return (
      <ul className="dyn-list">
        {data.map((item, i) => (
          <li key={i}>
            <DynamicOutput data={item} />
          </li>
        ))}
      </ul>
    );
  }
  if (typeof data === "object") {
    const keys = Object.keys(data);
    if (keys.length === 0) {
      return <p className="dyn-empty">{"{}"}</p>;
    }
    return (
      <div className="dyn-nested">
        {keys.map((k) => (
          <div key={k} className="dyn-block">
            <h4 className="dyn-block-title">{titleCaseKey(k)}</h4>
            <DynamicOutput data={data[k]} />
          </div>
        ))}
      </div>
    );
  }
  return <p className="dyn-empty">Unsupported type</p>;
}
