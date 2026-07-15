#!/usr/bin/env python3
"""Headless, time-limited BlueZ Just Works pairing agent."""

import os
import re
import time

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

AGENT_PATH = "/convbased/agent"
CAPABILITY = "NoInputNoOutput"
ADAPTER_INTERFACE = "org.bluez.Adapter1"
DEVICE_INTERFACE = "org.bluez.Device1"
PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties"

ADAPTER_NAME = os.environ.get("CONVBASED_HCI", "").strip()
if ADAPTER_NAME and not re.fullmatch(r"hci\d+", ADAPTER_NAME):
    raise SystemExit("CONVBASED_HCI must look like hci0")

try:
    PAIRING_WINDOW_SEC = int(os.environ.get("CONVBASED_PAIRING_WINDOW_SEC", "300"))
except ValueError as error:
    raise SystemExit("CONVBASED_PAIRING_WINDOW_SEC must be an integer") from error
if PAIRING_WINDOW_SEC < 0:
    raise SystemExit("CONVBASED_PAIRING_WINDOW_SEC must be >= 0")


class Agent(dbus.service.Object):
    @dbus.service.method("org.bluez.Agent1", in_signature="", out_signature="")
    def Release(self):
        pass

    @dbus.service.method("org.bluez.Agent1", in_signature="os", out_signature="")
    def AuthorizeService(self, device, uuid):
        print("AuthorizeService OK", device, uuid, flush=True)

    @dbus.service.method("org.bluez.Agent1", in_signature="o", out_signature="s")
    def RequestPinCode(self, device):
        return "0000"

    @dbus.service.method("org.bluez.Agent1", in_signature="o", out_signature="u")
    def RequestPasskey(self, device):
        return dbus.UInt32(0)

    @dbus.service.method("org.bluez.Agent1", in_signature="ou", out_signature="")
    def RequestConfirmation(self, device, passkey):
        print("RequestConfirmation auto-yes", device, passkey, flush=True)

    @dbus.service.method("org.bluez.Agent1", in_signature="o", out_signature="")
    def RequestAuthorization(self, device):
        print("RequestAuthorization OK", device, flush=True)

    @dbus.service.method("org.bluez.Agent1", in_signature="ouq", out_signature="")
    def DisplayPasskey(self, device, passkey, entered):
        pass

    @dbus.service.method("org.bluez.Agent1", in_signature="os", out_signature="")
    def DisplayPinCode(self, device, pincode):
        pass

    @dbus.service.method("org.bluez.Agent1", in_signature="", out_signature="")
    def Cancel(self):
        pass


dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
bus = dbus.SystemBus()
object_manager = dbus.Interface(
    bus.get_object("org.bluez", "/"), "org.freedesktop.DBus.ObjectManager"
)
selected_adapter = None


def adapter_candidates():
    candidates = []
    for path, interfaces in object_manager.GetManagedObjects().items():
        properties = interfaces.get(ADAPTER_INTERFACE)
        if properties is not None:
            candidates.append((str(path), bool(properties.get("Powered", False))))
    return sorted(candidates, key=lambda item: (not item[1], item[0]))


def choose_adapter():
    candidates = adapter_candidates()
    if ADAPTER_NAME:
        wanted = "/org/bluez/%s" % ADAPTER_NAME
        if any(path == wanted for path, _ in candidates):
            return wanted
        raise RuntimeError("adapter %s is not present" % ADAPTER_NAME)
    if not candidates:
        raise RuntimeError("no Bluetooth adapter is present")
    return candidates[0][0]


def configure_adapter(path):
    properties = dbus.Interface(bus.get_object("org.bluez", path), PROPERTIES_INTERFACE)
    settings = [
        ("Powered", True),
        ("Discoverable", False),
        ("Pairable", False),
        ("PairableTimeout", dbus.UInt32(PAIRING_WINDOW_SEC)),
        ("DiscoverableTimeout", dbus.UInt32(PAIRING_WINDOW_SEC)),
        ("Alias", "Convbased Mic"),
        ("Pairable", True),
        ("Discoverable", True),
    ]
    for key, value in settings:
        properties.Set(ADAPTER_INTERFACE, key, value)
    duration = "permanently" if PAIRING_WINDOW_SEC == 0 else "%ss" % PAIRING_WINDOW_SEC
    print("pairing enabled on %s for %s" % (path.rsplit("/", 1)[-1], duration), flush=True)


def trust_if_paired(path, properties):
    if not bool(properties.get("Paired", False)):
        return
    try:
        proxy = dbus.Interface(bus.get_object("org.bluez", path), PROPERTIES_INTERFACE)
        proxy.Set(DEVICE_INTERFACE, "Trusted", True)
        print("trusted paired device", path, flush=True)
    except Exception as error:
        print("trust error", path, error, flush=True)


def interfaces_added(path, interfaces):
    global selected_adapter
    if ADAPTER_INTERFACE in interfaces:
        name = str(path).rsplit("/", 1)[-1]
        if (ADAPTER_NAME and name == ADAPTER_NAME) or (not ADAPTER_NAME and selected_adapter is None):
            selected_adapter = str(path)
            try:
                configure_adapter(selected_adapter)
            except Exception as error:
                print("adapter configure error", error, flush=True)
    if DEVICE_INTERFACE in interfaces:
        trust_if_paired(str(path), interfaces[DEVICE_INTERFACE])


def interfaces_removed(path, interfaces):
    global selected_adapter
    if ADAPTER_INTERFACE in interfaces and str(path) == selected_adapter:
        selected_adapter = None


def properties_changed(interface, changed, _invalidated, path=None):
    if interface == DEVICE_INTERFACE and bool(changed.get("Paired", False)):
        trust_if_paired(str(path), changed)


agent = Agent(bus, AGENT_PATH)
manager = dbus.Interface(
    bus.get_object("org.bluez", "/org/bluez"), "org.bluez.AgentManager1"
)
manager.RegisterAgent(AGENT_PATH, CAPABILITY)
manager.RequestDefaultAgent(AGENT_PATH)
print("agent registered as default (%s)" % CAPABILITY, flush=True)

deadline = time.monotonic() + 30
while True:
    try:
        selected_adapter = choose_adapter()
        configure_adapter(selected_adapter)
        break
    except Exception as error:
        if time.monotonic() >= deadline:
            raise SystemExit("adapter setup failed after 30s: %s" % error)
        time.sleep(1)

for device_path, interfaces in object_manager.GetManagedObjects().items():
    if DEVICE_INTERFACE in interfaces:
        trust_if_paired(str(device_path), interfaces[DEVICE_INTERFACE])

bus.add_signal_receiver(
    interfaces_added,
    dbus_interface="org.freedesktop.DBus.ObjectManager",
    signal_name="InterfacesAdded",
)
bus.add_signal_receiver(
    interfaces_removed,
    dbus_interface="org.freedesktop.DBus.ObjectManager",
    signal_name="InterfacesRemoved",
)
bus.add_signal_receiver(
    properties_changed,
    dbus_interface=PROPERTIES_INTERFACE,
    signal_name="PropertiesChanged",
    path_keyword="path",
)
print("waiting for pairing", flush=True)
GLib.MainLoop().run()
