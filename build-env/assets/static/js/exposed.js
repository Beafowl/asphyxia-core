function emit(event, data) {
  return axios.post(`/emit/event/${event}`, data);
}
