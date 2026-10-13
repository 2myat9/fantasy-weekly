// A saved response that is not JSON is imported as its text.
declare module "*?raw" {
  const text: string;
  export default text;
}
